#!/usr/bin/env node
/**
 * AgilFrame — LiveKit Egress health check + optional start/stop smoke.
 *
 * It answers the one question that matters after deploying the worker:
 * "does the LiveKit server that dispatches jobs actually see an egress
 * worker through the shared Redis?" It checks:
 *
 *   1. rendered config / /out volume presence (no secrets read or printed)
 *   2. Redis PING + psrpc subscriptions for EgressInternal/StartEgress
 *      (`PUBSUB CHANNELS` / `PUBSUB NUMSUB`) — proves worker registration
 *   3. `lk egress list` against the LiveKit Twirp API (authoritative)
 *   4. optional `GET /v1/admin/egress/status` on the app (checks the app's
 *      AGIL_EGRESS_URL/keys are configured)
 *   5. optional start/stop smoke via the app API, dry-run by default
 *
 * Usage:
 *   cp deploy/egress/.env.example deploy/egress/.env   # fill values, chmod 600
 *   node scripts/egress-health.mjs                     # read-only; smoke plan only
 *   node scripts/egress-health.mjs --json
 *   node scripts/egress-health.mjs --run \
 *     --room=<app-room-id> --token=<host-app-token> --kind=hls --publisher
 *
 * Flags (all optional):
 *   --env-file=PATH     default deploy/egress/.env when it exists
 *   --redis=HOST:PORT   default EGRESS_REDIS_ADDRESS
 *   --redis-tls         use TLS (or EGRESS_REDIS_TLS=1 / rediss://)
 *   --redis-ca=PATH     CA bundle for Redis TLS (PEM file; its contents are passed to Node)
 *   --lk=PATH           lk binary (default LK_BIN or `lk` on PATH)
 *   --url=URL           LiveKit Twirp base (default AGIL_EGRESS_URL)
 *   --api-key=...       prefer env AGIL_EGRESS_API_KEY / AGIL_SFU_API_KEY
 *   --api-secret=...    prefer env AGIL_EGRESS_API_SECRET / LIVEKIT_API_SECRET
 *   --app-url=URL       default AGIL_APP_URL / AGIL_PUBLIC_ORIGIN
 *   --admin-key=...     prefer env AGIL_ADMIN_KEY (admin API, never logged)
 *   --room=ID           app room UUID for the smoke
 *   --token=...         prefer env EGRESS_SMOKE_TOKEN (argv is visible in ps)
 *   --kind=hls|recording|rtmp   smoke output (default hls)
 *   --rtmp-url=...      required for --kind=rtmp (stream key, never logged)
 *   --publisher         start `lk load-test` for the smoke
 *   --seconds=15        hold the egress active (5..300)
 *   --warmup=10         publisher warm-up before start (0..120)
 *   --run               actually start/stop egress (default: dry-run)
 *   --dry-run           force the smoke plan even if --run/--smoke was passed
 *   --skip-redis / --skip-lk / --skip-app / --skip-config / --skip-out
 *   --json              machine-readable output
 *   --help
 *
 * Secrets are never printed: tokens, API secrets, Redis passwords (including
 * the userinfo password in a `rediss://` URL), S3 secrets and RTMP URLs are
 * scrubbed from normal and `--json` output. `lk` receives credentials through
 * LIVEKIT_* environment variables, not argv, so they do not appear in `ps`.
 *
 * Exit codes: 0 = all selected checks passed; 1 = a check or the smoke failed.
 */

import { spawn } from 'node:child_process';
import { accessSync, constants as fsConstants, existsSync, readFileSync, statSync } from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..', '..');
const DEFAULT_ENV_FILE = path.join(REPO_ROOT, 'agil', 'core', 'deploy', 'egress', '.env');

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const VALUE_FLAGS = new Set([
  'env-file', 'redis', 'redis-ca', 'lk', 'url', 'api-key', 'api-secret',
  'app-url', 'admin-key', 'room', 'token', 'kind', 'rtmp-url', 'seconds', 'warmup',
]);
const BOOL_FLAGS = new Set([
  'help', 'json', 'run', 'smoke', 'dry-run', 'publisher', 'redis-tls',
  'skip-redis', 'skip-lk', 'skip-app', 'skip-config', 'skip-out',
]);

function parseArgs(argv) {
  const values = new Map();
  const bools = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      bools.add('help');
      continue;
    }
    if (!arg.startsWith('--')) throw new Error('unexpected argument (values are never echoed)');
    const eq = arg.indexOf('=');
    const name = (eq === -1 ? arg.slice(2) : arg.slice(2, eq)).trim();
    if (VALUE_FLAGS.has(name)) {
      if (eq !== -1) {
        values.set(name, arg.slice(eq + 1));
      } else {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) throw new Error(`--${name} needs a value`);
        values.set(name, next);
        i += 1;
      }
    } else if (BOOL_FLAGS.has(name)) {
      if (eq !== -1) throw new Error(`--${name} does not take a value`);
      bools.add(name);
    } else {
      // Do not echo the flag: an operator may accidentally paste a secret after
      // `--` and error output often ends up in tickets/CI logs.
      throw new Error('unknown flag (run --help for supported flags)');
    }
  }
  return { values, bools };
}

let parsed;
try {
  parsed = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(`[FAIL] ${error.message}`);
  console.error('Run with --help for usage.');
  process.exit(1);
}

if (parsed.bools.has('help')) {
  const help = readFileSync(fileURLToPath(import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => line.startsWith(' *') && !line.trim().startsWith('*/'))
    .join('\n');
  console.log(help.replace(/^ \* ?/gm, ''));
  process.exit(0);
}

const dryRun = parsed.bools.has('dry-run');
const opts = {
  envFile: parsed.values.get('env-file'),
  redis: parsed.values.get('redis'),
  redisCa: parsed.values.get('redis-ca'),
  lk: parsed.values.get('lk'),
  url: parsed.values.get('url'),
  apiKey: parsed.values.get('api-key'),
  apiSecret: parsed.values.get('api-secret'),
  appUrl: parsed.values.get('app-url'),
  adminKey: parsed.values.get('admin-key'),
  room: parsed.values.get('room'),
  token: parsed.values.get('token'),
  kind: (parsed.values.get('kind') || 'hls').toLowerCase(),
  rtmpUrl: parsed.values.get('rtmp-url'),
  seconds: Number(parsed.values.get('seconds') ?? 15),
  warmup: Number(parsed.values.get('warmup') ?? 10),
  run: (parsed.bools.has('run') || parsed.bools.has('smoke')) && !dryRun,
  dryRun,
  publisher: parsed.bools.has('publisher'),
  redisTls: parsed.bools.has('redis-tls'),
  json: parsed.bools.has('json'),
  skip: {
    redis: parsed.bools.has('skip-redis'),
    lk: parsed.bools.has('skip-lk'),
    app: parsed.bools.has('skip-app'),
    config: parsed.bools.has('skip-config'),
    out: parsed.bools.has('skip-out'),
  },
};

// ---------------------------------------------------------------------------
// Env file (simple dotenv; never printed)
// ---------------------------------------------------------------------------

function loadEnvFile(file) {
  const text = readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    // Shell/CLI values win; the file fills only missing variables.
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

if (opts.envFile) {
  if (!existsSync(opts.envFile)) {
    console.error(`[FAIL] env file not found: ${opts.envFile}`);
    process.exit(1);
  }
  try {
    loadEnvFile(opts.envFile);
  } catch (error) {
    console.error(`[FAIL] cannot read env file: ${error.message}`);
    process.exit(1);
  }
} else if (existsSync(DEFAULT_ENV_FILE)) {
  loadEnvFile(DEFAULT_ENV_FILE);
}

// ---------------------------------------------------------------------------
// Resolved configuration and redaction
// ---------------------------------------------------------------------------

function normalizeHttpUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  let url;
  try {
    url = new URL(value);
  } catch {
    // Node's URL error can include the input; the input may carry userinfo.
    throw new Error('invalid URL (value redacted)');
  }
  if (url.protocol === 'ws:') url.protocol = 'http:';
  else if (url.protocol === 'wss:') url.protocol = 'https:';
  else if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported URL protocol (value redacted)');
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/+$/, '');
}

const config = {
  livekitUrl: '',
  appUrl: '',
  redis: opts.redis || process.env.EGRESS_REDIS_ADDRESS || '',
  redisUser: process.env.EGRESS_REDIS_USERNAME || '',
  redisPassword: process.env.EGRESS_REDIS_PASSWORD || '',
  redisCa: opts.redisCa || process.env.EGRESS_REDIS_CA || '',
  redisTls: opts.redisTls || /^(1|true|yes|on)$/i.test(process.env.EGRESS_REDIS_TLS || '') || /^rediss:\/\//i.test(opts.redis || process.env.EGRESS_REDIS_ADDRESS || ''),
  egressUid: Number.parseInt(process.env.EGRESS_UID || '1001', 10),
  egressGid: Number.parseInt(process.env.EGRESS_GID || '0', 10),
  apiKey: opts.apiKey || process.env.AGIL_EGRESS_API_KEY || process.env.AGIL_SFU_API_KEY || process.env.LIVEKIT_API_KEY || '',
  apiSecret: opts.apiSecret || process.env.AGIL_EGRESS_API_SECRET || process.env.AGIL_SFU_API_SECRET || process.env.LIVEKIT_API_SECRET || '',
  adminKey: opts.adminKey || process.env.AGIL_ADMIN_KEY || '',
  lk: opts.lk || process.env.LK_BIN || 'lk',
  configFile: process.env.EGRESS_CONFIG_FILE || '/etc/agil-egress/egress.yaml',
  outDir: process.env.EGRESS_OUT_DIR || '/srv/agil-egress/out',
  room: opts.room || process.env.EGRESS_SMOKE_ROOM || '',
  token: opts.token || process.env.EGRESS_SMOKE_TOKEN || '',
  rtmpUrl: opts.rtmpUrl || process.env.EGRESS_SMOKE_RTMP_URL || '',
  kind: opts.kind,
  seconds: Number.isFinite(opts.seconds) ? Math.min(300, Math.max(5, Math.trunc(opts.seconds))) : 15,
  warmup: Number.isFinite(opts.warmup) ? Math.min(120, Math.max(0, Math.trunc(opts.warmup))) : 10,
};

function urlPassword(raw) {
  try {
    return decodeURIComponent(new URL(String(raw || '')).password || '');
  } catch {
    return '';
  }
}

const redisUrlPassword = urlPassword(config.redis);

try {
  config.livekitUrl = normalizeHttpUrl(opts.url || process.env.AGIL_EGRESS_URL || process.env.LIVEKIT_URL || 'https://sfu.example.com');
  config.appUrl = normalizeHttpUrl(opts.appUrl || process.env.AGIL_APP_URL || process.env.AGIL_PUBLIC_ORIGIN || 'https://calls.example.com');
} catch (error) {
  console.error(`[FAIL] invalid URL: ${error.message}`);
  process.exit(1);
}

const runId = Date.now().toString(36);
const secretValues = [
  config.apiSecret,
  config.token,
  config.adminKey,
  config.redisPassword,
  redisUrlPassword,
  process.env.MINIO_ROOT_PASSWORD,
  process.env.AWS_SESSION_TOKEN,
  process.env.EGRESS_S3_SECRET_KEY,
  process.env.AWS_SECRET_ACCESS_KEY,
  config.rtmpUrl,
].filter((value) => typeof value === 'string' && value.length > 0);

function scrub(value) {
  let text = String(value ?? '');
  for (const secret of secretValues) text = text.split(secret).join('***');
  text = text.replace(/rtmps?:\/\/[^\s"'<>]+/gi, (match) => {
    try {
      const url = new URL(match);
      return `${url.protocol}//${url.host}/…`;
    } catch {
      return 'rtmp://…';
    }
  });
  text = text.replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer ***');
  // JWT-shaped strings (app tokens can end up in generic errors).
  text = text.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '***JWT***');
  return text;
}

/** Strips userinfo from a URL before it is printed (passwords never appear). */
function redactUrlForDisplay(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    return scrub(url.toString().replace(/\/+$/, ''));
  } catch {
    return scrub(value);
  }
}

/** Redis may be `host:port` or a `redis(s)://user:pass@host:port/db` URL. */
function redactRedisTarget(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  if (/^rediss?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}`;
    } catch {
      return '<invalid redis URL>';
    }
  }
  return scrub(value);
}

// ---------------------------------------------------------------------------
// Result collection
// ---------------------------------------------------------------------------

const checks = [];
const failures = [];
const warnings = [];

function record(status, name, detail = '', error = '') {
  const entry = { status, name, detail: scrub(detail) };
  if (error) entry.error = scrub(error);
  checks.push(entry);
  if (status === 'FAIL') failures.push(`${name}: ${entry.error || entry.detail}`);
  if (status === 'WARN') warnings.push(`${name}: ${entry.detail || entry.error}`);
  if (!opts.json) {
    const suffix = [entry.detail, entry.error].filter(Boolean).join(' — ');
    console.log(`[${status}] ${name.padEnd(26)} ${suffix}`.trimEnd());
  }
  return entry;
}
function pass(name, detail) { return record('PASS', name, detail); }
function fail(name, detail, error) { return record('FAIL', name, detail, error); }
function skip(name, detail) { return record('SKIP', name, detail); }
function warn(name, detail, error) { return record('WARN', name, detail, error); }

// ---------------------------------------------------------------------------
// Minimal RESP client (no external deps; PING / PUBSUB only)
// ---------------------------------------------------------------------------

function encodeCommand(args) {
  const chunks = [Buffer.from(`*${args.length}\r\n`)];
  for (const arg of args) {
    const value = Buffer.from(String(arg));
    chunks.push(Buffer.from(`$${value.length}\r\n`), value, Buffer.from('\r\n'));
  }
  return Buffer.concat(chunks);
}

function parseReply(buffer, offset) {
  if (offset >= buffer.length) return null;
  const type = String.fromCharCode(buffer[offset]);
  const lineEnd = buffer.indexOf('\r\n', offset + 1);
  if (lineEnd === -1) return null;
  const line = buffer.subarray(offset + 1, lineEnd).toString('utf8');
  const next = lineEnd + 2;
  switch (type) {
    case '+':
      return { value: line, offset: next };
    case '-':
      return { value: { error: line }, offset: next };
    case ':':
      return { value: Number(line), offset: next };
    case '$': {
      const length = Number(line);
      if (length === -1) return { value: null, offset: next };
      if (!Number.isFinite(length) || length < 0) throw new Error('invalid Redis bulk length');
      if (buffer.length < next + length + 2) return null;
      return { value: buffer.subarray(next, next + length).toString('utf8'), offset: next + length + 2 };
    }
    case '*': {
      const count = Number(line);
      if (count === -1) return { value: null, offset: next };
      if (!Number.isFinite(count) || count < 0) throw new Error('invalid Redis array length');
      const array = [];
      let cursor = next;
      for (let i = 0; i < count; i += 1) {
        const item = parseReply(buffer, cursor);
        if (!item) return null;
        array.push(item.value);
        cursor = item.offset;
      }
      return { value: array, offset: cursor };
    }
    default:
      throw new Error(`unexpected Redis reply type: ${type}`);
  }
}

class RedisClient {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.pending = [];
    this.closed = false;
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', (error) => this.abort(error));
    socket.on('close', () => this.abort(new Error('Redis connection closed')));
  }

  static connect({ host, port, useTls, ca, timeoutMs }) {
    return new Promise((resolve, reject) => {
      const options = { host, port };
      let socket;
      try {
        // RFC 6066 forbids an IP address as SNI; only set it for hostnames.
        const tlsOptions = { ...options, ...(ca ? { ca } : {}), ...(net.isIP(host) === 0 ? { servername: host } : {}) };
        socket = useTls ? tls.connect(tlsOptions) : net.connect(options);
      } catch (error) {
        reject(error);
        return;
      }
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Redis connect timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const onError = (error) => {
        clearTimeout(timer);
        reject(error);
      };
      socket.once('error', onError);
      socket.once(useTls ? 'secureConnect' : 'connect', () => {
        clearTimeout(timer);
        socket.removeListener('error', onError);
        resolve(new RedisClient(socket));
      });
    });
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length > 0) {
      let reply;
      try {
        reply = parseReply(this.buffer, 0);
      } catch (error) {
        this.abort(error);
        return;
      }
      if (!reply) return;
      this.buffer = this.buffer.subarray(reply.offset);
      const pending = this.pending.shift();
      if (!pending) continue;
      if (reply.value && typeof reply.value === 'object' && !Array.isArray(reply.value) && reply.value.error) {
        pending.reject(new Error(String(reply.value.error)));
      } else {
        pending.resolve(reply.value);
      }
    }
  }

  command(args) {
    if (this.closed) return Promise.reject(new Error('Redis connection is closed'));
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
      this.socket.write(encodeCommand(args));
    });
  }

  abort(error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.splice(0)) pending.reject(error);
    this.socket.destroy();
  }

  close() {
    this.abort(new Error('Redis check finished'));
  }
}

function parseRedisAddress(raw) {
  const value = String(raw || '').trim();
  if (!value) throw new Error('EGRESS_REDIS_ADDRESS is empty');
  if (/^(rediss?):\/\//i.test(value)) {
    const url = new URL(value);
    return {
      host: url.hostname,
      port: Number(url.port || 6379),
      useTls: url.protocol === 'rediss:',
      username: decodeURIComponent(url.username || ''),
      password: decodeURIComponent(url.password || ''),
      db: url.pathname && url.pathname !== '/' ? Number(url.pathname.slice(1)) : undefined,
    };
  }
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end === -1) throw new Error('invalid IPv6 Redis address');
    return { host: value.slice(1, end), port: Number(value.slice(end + 1).replace(/^:/, '') || 6379) };
  }
  const colon = value.lastIndexOf(':');
  if (colon === -1) return { host: value, port: 6379 };
  const host = value.slice(0, colon);
  const port = Number(value.slice(colon + 1));
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`invalid Redis address: ${value}`);
  return { host, port };
}

async function checkRedis() {
  if (opts.skip.redis) {
    skip('redis worker', 'skipped (--skip-redis)');
    return false;
  }
  let target;
  try {
    target = parseRedisAddress(config.redis);
  } catch (error) {
    fail('redis worker', '', error.message);
    return false;
  }

  let client;
  const useTls = config.redisTls || Boolean(target.useTls);
  let ca;
  if (useTls && config.redisCa) {
    try {
      // `tls.connect({ ca })` expects PEM contents, not a filename.
      ca = readFileSync(config.redisCa, 'utf8');
      if (!ca.includes('BEGIN CERTIFICATE')) throw new Error('not a PEM certificate bundle');
    } catch {
      fail('redis worker', '', 'cannot read --redis-ca PEM file (path redacted; expected a CA bundle)');
      return false;
    }
  }
  try {
    client = await RedisClient.connect({
      host: target.host,
      port: target.port,
      useTls,
      ca: ca || undefined,
      timeoutMs: 4000,
    });
    const username = config.redisUser || target.username || '';
    const password = config.redisPassword || target.password || '';
    if (password) {
      await client.command(username ? ['AUTH', username, password] : ['AUTH', password]);
    }
    const db = Number(process.env.EGRESS_REDIS_DB || target.db || 0);
    if (Number.isInteger(db) && db > 0) await client.command(['SELECT', db]);

    const pong = await client.command(['PING']);
    if (String(pong).toUpperCase() !== 'PONG') throw new Error('unexpected PING reply');

    const allChannels = await client.command(['PUBSUB', 'CHANNELS', '*']);
    const channels = Array.isArray(allChannels) ? allChannels.map(String) : [];
    const requestChannels = channels.filter((channel) => channel.includes('EgressInternal') && channel.includes('StartEgress') && /(?:\||\.)REQ$/i.test(channel));
    const claimChannels = channels.filter((channel) => channel.includes('EgressInternal') && channel.includes('StartEgress') && /(?:\||\.)RCLAIM$/i.test(channel));

    let subscribers = 0;
    const channelCounts = [];
    for (const channel of requestChannels) {
      const reply = await client.command(['PUBSUB', 'NUMSUB', channel]);
      const count = Array.isArray(reply) ? Number(reply[1] || 0) : 0;
      subscribers += Number.isFinite(count) ? count : 0;
      channelCounts.push(`${channel}=${count}`);
    }

    if (requestChannels.length === 0) {
      fail('redis worker', `PING ok at ${target.host}:${target.port}`, 'no EgressInternal|StartEgress|…|REQ subscription; worker is not registered on this Redis (wrong Redis, tunnel down, or worker not running)');
      return false;
    }
    if (subscribers < 1) {
      fail('redis worker', `channels found: ${requestChannels.join(', ')}`, 'egress worker subscription count is 0 on the StartEgress channel');
      return false;
    }
    pass('redis worker', `PING ok; ${subscribers} worker subscription(s) on ${channelCounts.join(', ')}${claimChannels.length ? `; ${claimChannels.length} claim channel(s)` : ''}`);
    return true;
  } catch (error) {
    fail('redis worker', `${target.host}:${target.port}`, error.message);
    return false;
  } finally {
    if (client) client.close();
  }
}

// ---------------------------------------------------------------------------
// Child process helpers
// ---------------------------------------------------------------------------

function runCapture(command, args, { env = {}, timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...env },
      });
    } catch (error) {
      resolve({ ok: false, code: null, out: '', err: error.message });
      return;
    }
    let out = '';
    let err = '';
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 2000);
      finish({ ok: false, code: null, out, err: `${err}\ncommand timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { out = (out + chunk.toString()).slice(-64 * 1024); });
    child.stderr.on('data', (chunk) => { err = (err + chunk.toString()).slice(-64 * 1024); });
    child.on('error', (error) => finish({ ok: false, code: null, out, err: `${err}\n${error.message}` }));
    child.on('close', (code) => finish({ ok: code === 0, code, out, err }));
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(250);
  }
  return predicate();
}

// ---------------------------------------------------------------------------
// Checks: config, app status, lk
// ---------------------------------------------------------------------------

function checkFiles() {
  if (!opts.skip.config) {
    if (existsSync(config.configFile)) pass('rendered config', `${config.configFile} present`);
    else fail('rendered config', config.configFile, 'not found; run `sh deploy/egress/render-config.sh` on the worker host (or pass --skip-config)');
  } else {
    skip('rendered config', 'skipped (--skip-config)');
  }

  if (!opts.skip.out) {
    let stat = null;
    try {
      stat = statSync(config.outDir);
    } catch {
      stat = null;
    }
    if (!stat) {
      warn('out volume', `${config.outDir} does not exist; /out backup and local output will fail`);
    } else if (!stat.isDirectory()) {
      warn('out volume', `${config.outDir} is not a directory`);
    } else {
      let hostWritable = true;
      try {
        accessSync(config.outDir, fsConstants.W_OK);
      } catch {
        hostWritable = false;
      }
      const uid = Number.isInteger(config.egressUid) ? config.egressUid : 1001;
      const gid = Number.isInteger(config.egressGid) ? config.egressGid : 0;
      // Root can write any directory, so `accessSync` alone is not a valid
      // probe when the health script runs under sudo. Check the mode bits for
      // the egress UID/GID (container runs as 1001:0 in this kit).
      const egressWritable =
        typeof process.getuid === 'function'
          ? stat.uid === uid
            ? (stat.mode & 0o200) !== 0
            : stat.gid === gid
              ? (stat.mode & 0o020) !== 0
              : (stat.mode & 0o002) !== 0
          : null;
      const mode = (stat.mode & 0o777).toString(8).padStart(3, '0');
      const owner = `${stat.uid}:${stat.gid}`;
      if (egressWritable === false) {
        warn(
          'out volume',
          `${config.outDir} is not writable by egress UID ${uid}:${gid} (mode ${mode}, owner ${owner}); run chown -R ${uid}:${gid} ${config.outDir}`,
        );
      } else if (!hostWritable) {
        pass(
          'out volume',
          `${config.outDir} writable by egress UID ${uid}:${gid} (mode ${mode}, owner ${owner}); current user cannot write it`,
        );
      } else {
        pass('out volume', `${config.outDir} writable by egress UID ${uid}:${gid} (mode ${mode}, owner ${owner})`);
      }
    }
  } else {
    skip('out volume', 'skipped (--skip-out)');
  }
}

async function fetchJson(url, { method = 'GET', headers = {}, body, timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method, headers, body, signal: controller.signal, redirect: 'error' });
    const text = await response.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* leave null */ }
    if (!response.ok) {
      const message = data?.error?.message || data?.msg || `HTTP ${response.status}`;
      const code = data?.error?.code || data?.code || '';
      const error = new Error(message);
      error.status = response.status;
      error.code = code;
      throw error;
    }
    return data;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`request timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function checkAppStatus() {
  if (opts.skip.app) {
    skip('app egress status', 'skipped (--skip-app)');
    return;
  }
  if (!config.adminKey) {
    skip('app egress status', 'AGIL_ADMIN_KEY not set');
    return;
  }
  try {
    const status = await fetchJson(`${config.appUrl}/v1/admin/egress/status`, {
      headers: { 'x-api-key': config.adminKey },
      timeoutMs: 10000,
    });
    const detail = `configured=${Boolean(status?.configured)} enabled=${Boolean(status?.enabled)} urlConfigured=${Boolean(status?.urlConfigured)} activeCount=${Number(status?.activeCount || 0)}`;
    if (!status?.configured) {
      fail('app egress status', detail, 'app does not see egress config; set AGIL_EGRESS_URL and AGIL_EGRESS_ENABLED=1, then restart the app');
    } else if (!status?.urlConfigured) {
      fail('app egress status', detail, 'AGIL_EGRESS_URL is empty; set it to the LiveKit Twirp base (https://sfu.example.com), not the worker health port');
    } else if (!status?.enabled) {
      warn('app egress status', `${detail} (egress intentionally disabled)`);
    } else if (status?.lastError) {
      warn('app egress status', `${detail}`, status.lastError);
    } else {
      pass('app egress status', detail);
    }
  } catch (error) {
    if (error.status === 401 || error.status === 403) {
      fail('app egress status', '', `admin key rejected (HTTP ${error.status})`);
    } else if (error.status === 404 || error.status === 501) {
      warn('app egress status', '', `admin endpoint unavailable (HTTP ${error.status}); verify with lk/Redis instead`);
    } else {
      fail('app egress status', '', error.message);
    }
  }
}

async function checkLk() {
  if (opts.skip.lk) {
    skip('lk egress list', 'skipped (--skip-lk)');
    return false;
  }
  if (!config.apiKey || !config.apiSecret) {
    fail('lk egress list', '', 'missing LiveKit API key/secret (set LIVEKIT_API_KEY/SECRET or AGIL_EGRESS_API_KEY/SECRET)');
    return false;
  }

  const version = await runCapture(config.lk, ['--version'], { timeoutMs: 5000 });
  if (!version.ok) {
    fail('lk egress list', config.lk, `lk not runnable: ${(version.err || version.out || 'not found').trim().split('\n')[0]} (install livekit-cli or pass --lk)`);
    return false;
  }

  const env = {
    LIVEKIT_URL: config.livekitUrl,
    LIVEKIT_API_KEY: config.apiKey,
    LIVEKIT_API_SECRET: config.apiSecret,
    LK_NO_SKILLS_PROMPT: '1',
    NO_COLOR: '1',
  };
  const result = await runCapture(config.lk, ['egress', 'list', '--json', '--limit', '50'], { env, timeoutMs: 20000 });

  if (!result.ok) {
    const detail = (result.err || result.out || `exit ${result.code}`).trim();
    fail('lk egress list', `lk egress list failed against ${redactUrlForDisplay(config.livekitUrl)}`, detail.slice(0, 700));
    return false;
  }

  let items = null;
  let parsedOutput = false;
  const text = result.out.trim();
  try {
    items = JSON.parse(text);
    parsedOutput = true;
  } catch {
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start !== -1 && end > start) {
      try {
        items = JSON.parse(text.slice(start, end + 1));
        parsedOutput = true;
      } catch {
        /* fall through */
      }
    }
  }

  const combinedOutput = `${result.out}\n${result.err}`;
  if (!Array.isArray(items)) {
    // `null` is a valid empty list only when the SFU did not report that it
    // cannot reach any egress worker. Check the error BEFORE accepting null.
    if (/no response from egress service/i.test(combinedOutput)) {
      fail('lk egress list', '', 'LiveKit says "no response from egress service": no worker is subscribed through the SFU Redis');
      return false;
    }
    if (parsedOutput && items === null) {
      items = [];
    } else {
      warn('lk egress list', 'command succeeded but output was not JSON; worker is reachable');
      return true;
    }
  }

  const active = items.filter((item) => /ACTIVE|STARTING|ENDING/i.test(statusOf(item))).length;
  pass('lk egress list', `${items.length} job(s), ${active} active/starting; worker reachable through ${redactUrlForDisplay(config.livekitUrl)}`);
  return true;
}

// ---------------------------------------------------------------------------
// Smoke
// ---------------------------------------------------------------------------

function statusOf(item) {
  const raw = item?.status;
  if (typeof raw === 'string') return raw.toUpperCase();
  const numeric = { 0: 'EGRESS_STARTING', 1: 'EGRESS_ACTIVE', 2: 'EGRESS_ENDING', 3: 'EGRESS_COMPLETE', 4: 'EGRESS_FAILED', 5: 'EGRESS_ABORTED', 6: 'EGRESS_LIMIT_REACHED' };
  return numeric[raw] || '';
}

function idOf(item) {
  return item?.egress_id || item?.egressId || item?.id || '';
}

async function listRoomEgress() {
  const data = await fetchJson(`${config.appUrl}/v1/rooms/${encodeURIComponent(config.room)}/egress`, {
    headers: { authorization: `Bearer ${config.token}` },
    timeoutMs: 10000,
  });
  if (Array.isArray(data?.egress)) return data.egress;
  if (Array.isArray(data?.sessions)) return data.sessions;
  if (Array.isArray(data?.active)) return data.active;
  return [];
}

function artifactLocations(item) {
  const locations = [];
  for (const key of ['file_results', 'fileResults', 'segment_results', 'segmentResults']) {
    const list = item?.[key];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const location = entry?.location || entry?.playlist_location || entry?.live_playlist_location
        || entry?.playlistLocation || entry?.livePlaylistLocation;
      if (!location) continue;
      try {
        const url = new URL(location);
        locations.push(`${url.protocol}//${url.host}${url.pathname}`);
      } catch {
        locations.push(scrub(location));
      }
    }
  }
  return locations;
}

function smokePlanLines() {
  const room = config.room || '<roomId>';
  const app = redactUrlForDisplay(config.appUrl);
  const kind = config.kind === 'rtmp' ? 'rtmp' : config.kind;
  return [
    `POST ${app}/v1/rooms/${room}/join (host token) -> media.room`,
    config.publisher ? 'lk load-test --video-publishers 1 (synthetic publisher)' : 'publisher must already be in the room (or pass --publisher)',
    `POST ${app}/v1/rooms/${room}/egress/start {"kind":"${kind}","layout":"speaker"${kind === 'rtmp' ? ',"rtmpUrl":"<redacted>"' : ''}}`,
    `GET ${app}/v1/rooms/${room}/egress until EGRESS_ACTIVE; hold ${config.seconds}s`,
    `POST ${app}/v1/rooms/${room}/egress/<egressId>/stop`,
    'GET .../egress until EGRESS_COMPLETE; report artifact locations',
  ];
}

async function runSmoke() {
  // Validate the plan even in dry-run: `--kind=bogus` must not produce a
  // misleading smoke plan.
  if (!['hls', 'recording', 'rtmp'].includes(config.kind)) {
    fail('smoke', `unsupported --kind=${config.kind}`, 'use hls, recording or rtmp');
    return;
  }
  if (!config.room || !config.token) {
    if (opts.run) {
      fail('smoke', '', '--run requires --room=<app room id> and --token=<host app join token>');
      return;
    }
    skip('smoke (dry-run)', 'no EGRESS_SMOKE_ROOM/TOKEN; plan only — pass --room/--token --run to execute');
    for (const line of smokePlanLines()) record('PLAN', 'smoke step', line);
    return;
  }

  if (!opts.run) {
    skip('smoke (dry-run)', `room=${config.room} kind=${config.kind}; pass --run to execute`);
    for (const line of smokePlanLines()) record('PLAN', 'smoke step', line);
    return;
  }

  if (config.kind === 'rtmp' && !config.rtmpUrl) {
    fail('smoke', '', '--kind=rtmp requires --rtmp-url or EGRESS_SMOKE_RTMP_URL');
    return;
  }

  const room = config.room;
  let egressId = '';
  let stopped = false;
  let publisher = null;

  const stopQuietly = async () => {
    if (!egressId || stopped) return;
    stopped = true;
    try {
      await fetchJson(`${config.appUrl}/v1/rooms/${encodeURIComponent(room)}/egress/${encodeURIComponent(egressId)}/stop`, {
        method: 'POST',
        headers: { authorization: `Bearer ${config.token}` },
        timeoutMs: 15000,
      });
      pass('egress stop (cleanup)', egressId);
    } catch (error) {
      warn('egress stop (cleanup)', `${egressId}: ${error.message}`);
    }
  };

  const killPublisher = async () => {
    if (!publisher) return;
    try { publisher.kill('SIGTERM'); } catch { /* ignore */ }
    await sleep(1500);
    if (publisher.exitCode === null) {
      try { publisher.kill('SIGKILL'); } catch { /* ignore */ }
    }
  };

  try {
    // Resolve the LiveKit room name and prove the token is a host token.
    const join = await fetchJson(`${config.appUrl}/v1/rooms/${encodeURIComponent(room)}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: config.token,
        name: 'Egress health check',
        participantId: `egress-health-${runId}`,
      }),
      timeoutMs: 15000,
    });
    const media = join?.media;
    if (!media || !media.room || !media.url) {
      throw new Error('join response has no media block; room is not in SFU/broadcast mode or the host token is invalid');
    }
    if (media.mode && String(media.mode).toLowerCase() !== 'sfu') {
      throw new Error(`join media.mode=${media.mode}; egress needs SFU mode (per-room scale.mediaMode=sfu)`);
    }
    pass('smoke room', `${media.room} via ${media.url} (mode=${media.mode || 'unknown'}, role=${join?.participant?.role || 'unknown'})`);

    if (config.publisher) {
      if (!config.apiKey || !config.apiSecret) throw new Error('--publisher needs LiveKit API key/secret (LIVEKIT_API_KEY/SECRET)');
      const duration = `${Math.ceil(config.seconds + config.warmup + 45)}s`;
      publisher = spawn(config.lk, [
        'load-test',
        '--room', media.room,
        '--video-publishers', '1',
        '--video-resolution', 'medium',
        '--duration', duration,
      ], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          LIVEKIT_URL: media.url,
          LIVEKIT_API_KEY: config.apiKey,
          LIVEKIT_API_SECRET: config.apiSecret,
          LK_NO_SKILLS_PROMPT: '1',
          NO_COLOR: '1',
        },
      });
      let log = '';
      let ready = false;
      let exitCode = null;
      publisher.stdout.on('data', (chunk) => {
        log = (log + chunk.toString()).slice(-8000);
        if (/publish|simulcast|joined|connected/i.test(log)) ready = true;
      });
      publisher.stderr.on('data', (chunk) => { log = (log + chunk.toString()).slice(-8000); });
      publisher.on('error', (error) => {
        log += `\n${error.message}`;
        exitCode = -1;
      });
      publisher.on('close', (code) => { exitCode = code; });
      await waitFor(() => ready || exitCode !== null, config.warmup * 1000);
      if (exitCode !== null && !ready) {
        throw new Error(`publisher exited early (code ${exitCode}): ${scrub(log).slice(0, 500)}`);
      }
      pass('smoke publisher', ready ? 'lk load-test publishing' : `started; warm-up ${config.warmup}s`);
    } else {
      skip('smoke publisher', 'assuming a participant is already publishing (use --publisher to add one)');
    }

    const startBody = { kind: config.kind, layout: 'speaker' };
    if (config.kind === 'rtmp') startBody.rtmpUrl = config.rtmpUrl;
    const started = await fetchJson(`${config.appUrl}/v1/rooms/${encodeURIComponent(room)}/egress/start`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(startBody),
      timeoutMs: 20000,
    });
    egressId = String(started?.egressId || '');
    if (!egressId) throw new Error('start response has no egressId');
    pass('smoke egress start', `${egressId} status=${started?.status || 'unknown'} kind=${config.kind}`);

    let item = null;
    let active = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const items = await listRoomEgress();
      item = items.find((entry) => idOf(entry) === egressId) || null;
      const status = statusOf(item);
      if (status === 'EGRESS_ACTIVE') { active = true; break; }
      if (status === 'EGRESS_FAILED' || status === 'EGRESS_ABORTED') {
        throw new Error(`egress ${egressId} ended with ${status}: ${item?.error || 'no error text'}`);
      }
      await sleep(2000);
    }
    if (!active) throw new Error(`egress ${egressId} did not reach EGRESS_ACTIVE in 60s (check worker logs / publisher)`);
    pass('smoke egress active', egressId);

    const deadline = Date.now() + config.seconds * 1000;
    while (Date.now() < deadline) {
      await sleep(Math.min(5000, Math.max(500, deadline - Date.now())));
      const items = await listRoomEgress();
      item = items.find((entry) => idOf(entry) === egressId) || item;
      const status = statusOf(item);
      if (status === 'EGRESS_FAILED' || status === 'EGRESS_ABORTED') {
        throw new Error(`egress ${egressId} failed while active: ${item?.error || 'no error text'}`);
      }
    }

    await fetchJson(`${config.appUrl}/v1/rooms/${encodeURIComponent(room)}/egress/${encodeURIComponent(egressId)}/stop`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.token}` },
      timeoutMs: 15000,
    });
    stopped = true;
    pass('smoke egress stop', egressId);

    let finalStatus = '';
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const items = await listRoomEgress();
      item = items.find((entry) => idOf(entry) === egressId) || item;
      finalStatus = statusOf(item);
      if (['EGRESS_COMPLETE', 'EGRESS_FAILED', 'EGRESS_ABORTED', 'EGRESS_LIMIT_REACHED'].includes(finalStatus)) break;
      await sleep(1500);
    }

    if (finalStatus === 'EGRESS_COMPLETE') {
      pass('smoke final status', `${egressId} EGRESS_COMPLETE`);
    } else if (finalStatus === 'EGRESS_FAILED' || finalStatus === 'EGRESS_ABORTED') {
      fail('smoke final status', `${egressId} ${finalStatus}`, item?.error || 'see worker logs');
    } else if (finalStatus === 'EGRESS_LIMIT_REACHED') {
      warn('smoke final status', `${egressId} EGRESS_LIMIT_REACHED (session_limits)`);
    } else {
      warn('smoke final status', `${egressId} ${finalStatus || 'unknown'} (still ending; MP4 finalizes on stop)`);
    }

    const locations = artifactLocations(item);
    if (locations.length) pass('smoke artifacts', locations.join(', '));
    else warn('smoke artifacts', 'no file/segment location in egress info yet; check S3/CDN and worker logs');
  } catch (error) {
    fail('smoke', '', error.message);
    await stopQuietly();
  } finally {
    await killPublisher();
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const redisDisplay = redactRedisTarget(config.redis);
  if (!opts.json) {
    console.log('AgilFrame — LiveKit Egress health check');
    console.log(`  LiveKit: ${redactUrlForDisplay(config.livekitUrl)}`);
    console.log(`  Redis:   ${redisDisplay ? `${redisDisplay}${config.redisTls ? ' (TLS)' : ''}` : '<not set>'}`);
    console.log(`  App:     ${redactUrlForDisplay(config.appUrl)}${config.adminKey ? ' (admin key set)' : ''}`);
    console.log(`  Mode:    ${config.run ? 'health + smoke' : 'health, smoke dry-run'}${opts.dryRun ? ' (--dry-run)' : ''}`);
    console.log('');
  }

  checkFiles();

  let redisOk = true;
  if (!opts.skip.redis) redisOk = await checkRedis();
  void redisOk;

  await checkAppStatus();
  await checkLk();

  if (opts.run && failures.length > 0) {
    fail('smoke', '', 'aborted because health checks failed; fix them before --run');
  } else {
    await runSmoke();
  }

  const ok = failures.length === 0;
  const summary = {
    ok,
    mode: opts.run ? 'smoke' : 'dry-run',
    dryRun: opts.dryRun || undefined,
    livekitUrl: redactUrlForDisplay(config.livekitUrl),
    appUrl: redactUrlForDisplay(config.appUrl),
    redis: redisDisplay ? `${redisDisplay}${config.redisTls ? ' (TLS)' : ''}` : null,
    checks,
    failures: failures.map(scrub),
    warnings: warnings.map(scrub),
  };

  if (opts.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log('');
    if (ok) console.log(`RESULT: PASS${opts.run ? ' (smoke completed)' : ' (read-only + smoke plan)'}`);
    else {
      console.log('RESULT: FAIL');
      for (const failure of failures) console.log(`  - ${scrub(failure)}`);
    }
  }

  process.exitCode = ok ? 0 : 1;
}

main().catch((error) => {
  console.error(`[FAIL] ${scrub(error?.stack || error?.message || error)}`);
  process.exitCode = 1;
});
