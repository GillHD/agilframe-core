#!/usr/bin/env node
/**
 * AgilFrame — production operations check (read-only).
 *
 * One command that answers "is this installation healthy right now?" without
 * touching the app, the SFU, Redis or the proxies:
 *
 *   - app:    GET /v1/health (HTTP status, JSON shape, uptime, security flags)
 *   - sfu:    GET / on each LiveKit node (LiveKit answers "OK"), latency
 *   - redis:  PING (direct TCP, `redis-cli` over SSH, or `docker exec` over SSH)
 *   - tls:    certificate dates, chain/hostname validity, DNS resolution
 *   - disk:   free space on the data path (node:fs.statfs)
 *   - memory: cgroup v2/v1 limit when present, otherwise host memory
 *   - egress: optional worker health endpoint (GET /)
 *   - docker: optional container state/restart count (docker inspect, read-only)
 *
 * Nothing is written, no secret is printed, and no command mutates state.
 * `PING` is the only Redis command used.
 *
 * Usage:
 *   node scripts/ops-check.mjs
 *   node scripts/ops-check.mjs --app-url=https://calls.example.com \
 *     --sfu=http://10.0.0.11:7880,http://10.0.0.12:7890 \
 *     --redis=10.0.0.11:6379 --tls-host=calls.example.com \
 *     --disk-path=/var/lib/docker/volumes/agil-calls_agil-data/_data --json
 *
 *   # on the app host, reusing non-secret values from .env
 *   sudo node scripts/ops-check.mjs --env-file /opt/agil-calls/.env --json
 *
 * Exit codes: 0 = all checks ok/skipped, 1 = at least one warning,
 *             2 = at least one critical failure (or a usage error).
 *
 * Flags:
 *   --app-url=URL          default AGIL_APP_URL / AGIL_PUBLIC_ORIGIN /
 *                          http://127.0.0.1:$PORT (8787)
 *   --sfu=URL[,URL]        LiveKit node URLs; default AGIL_SFU_NODES or
 *                          AGIL_SFU_URL (ws/wss converted to http/https)
 *   --redis=HOST:PORT      Redis endpoint (redis:// URLs are accepted too);
 *                          default AGIL_REDIS_ADDRESS or empty
 *   --ssh=USER@HOST        run the Redis ping over SSH (read-only)
 *   --redis-container=NAME container name for `docker exec ... redis-cli PING`
 *                          (requires --ssh; default: none -> redis-cli on host)
 *   --tls-host=HOST        certificate/domain to verify; default: app host when
 *                          the app URL is https and not localhost
 *   --tls-port=PORT        default 443
 *   --disk-path=PATH       default AGIL_DATA_DIR if it exists, else /
 *   --egress-url=URL       egress worker health endpoint, e.g.
 *                          http://127.0.0.1:8080/ (default: skipped; env
 *                          AGIL_EGRESS_HEALTH_URL, NOT the Twirp base URL)
 *   --docker-container=NAME check container state/restarts (default: skipped)
 *   --disk-warn=PCT        80, --disk-crit=PCT 90
 *   --mem-warn=PCT         85, --mem-crit=PCT 95
 *   --tls-warn-days=N      21, --tls-crit-days=N 7
 *   --slow-ms=N            warn above this response time (default 1500)
 *   --timeout=MS           per-check timeout (default 5000)
 *   --skip=LIST            app,sfu,redis,tls,disk,mem,egress,docker
 *   --expect-prod          warn when docs/MCP/admin exposure is enabled
 *   --allow-admin-api      do not warn about adminApiEnabled under --expect-prod
 *   --env-file=PATH        read a whitelist of non-secret values from a .env
 *   --json                 machine-readable output (single JSON object)
 *   --quiet                no human output (exit code only)
 *   --help, -h
 */

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import dns from 'node:dns';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..', '..');

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

const VALUE_FLAGS = new Set([
  'app-url', 'sfu', 'redis', 'ssh', 'redis-container', 'tls-host', 'tls-port',
  'disk-path', 'egress-url', 'docker-container', 'disk-warn', 'disk-crit',
  'mem-warn', 'mem-crit', 'tls-warn-days', 'tls-crit-days', 'slow-ms',
  'timeout', 'skip', 'env-file',
]);
const BOOL_FLAGS = new Set(['json', 'quiet', 'help', 'expect-prod', 'allow-admin-api']);

function parseArgs(argv) {
  const values = new Map();
  const bools = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      bools.add('help');
      continue;
    }
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`);
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
      throw new Error(`unknown flag: --${name}`);
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
  process.exit(2);
}

const { values: FLAGS, bools: BOOLS } = parsed;

if (BOOLS.has('help')) {
  const source = await fs.readFile(fileURLToPath(import.meta.url), 'utf8');
  const start = source.indexOf('/**');
  const end = source.indexOf('*/');
  console.log(source.slice(start, end + 2).replace(/^\s*\/\*\*|\*\/$/gm, '').replace(/^ \* ?/gm, ''));
  process.exit(0);
}

// ---------------------------------------------------------------------------
// .env whitelist (never secrets, never printed)
// ---------------------------------------------------------------------------

const ENV_WHITELIST = new Set([
  'AGIL_APP_URL', 'AGIL_PUBLIC_ORIGIN', 'PORT', 'AGIL_SFU_URL', 'AGIL_SFU_NODES',
  'AGIL_REDIS_ADDRESS', 'AGIL_EGRESS_HEALTH_URL', 'AGIL_DATA_DIR', 'AGIL_DISK_PATH',
  'AGIL_DISK_WARN_PCT', 'AGIL_DISK_CRIT_PCT', 'AGIL_MEM_WARN_PCT',
  'AGIL_MEM_CRIT_PCT', 'AGIL_TLS_WARN_DAYS', 'AGIL_TLS_CRIT_DAYS',
  'AGIL_OPS_SSH', 'AGIL_REDIS_CONTAINER', 'AGIL_DOCKER_CONTAINER',
]);

async function loadEnvFile(file) {
  const resolved = path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
  const raw = await fs.readFile(resolved, 'utf8');
  let applied = 0;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!ENV_WHITELIST.has(key)) continue;
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!value) continue;
    if (process.env[key] === undefined) {
      process.env[key] = value;
      applied += 1;
    }
  }
  return { file: resolved, applied };
}

let envFileInfo = null;
if (FLAGS.has('env-file')) {
  try {
    envFileInfo = await loadEnvFile(FLAGS.get('env-file'));
  } catch (error) {
    console.error(`[FAIL] cannot read --env-file: ${error.message}`);
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function envStr(name, fallback = '') {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function numFlag(name, envName, fallback, min, max) {
  const raw = FLAGS.has(name) ? FLAGS.get(name) : envStr(envName, '');
  if (raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`invalid value for --${name}: ${raw} (expected ${min}..${max})`);
  }
  return value;
}

let CONFIG;
try {
  const timeout = Number(FLAGS.get('timeout') ?? 5000);
  if (!Number.isFinite(timeout) || timeout < 500 || timeout > 120000) {
    throw new Error('--timeout must be 500..120000 ms');
  }
  const port = Number(envStr('PORT', '8787')) || 8787;
  const appUrlRaw = FLAGS.get('app-url') || envStr('AGIL_APP_URL') || envStr('AGIL_PUBLIC_ORIGIN') || `http://127.0.0.1:${port}`;
  const sfuRaw = FLAGS.get('sfu') || envStr('AGIL_SFU_NODES') || envStr('AGIL_SFU_URL');
  const redisRaw = FLAGS.get('redis') || envStr('AGIL_REDIS_ADDRESS');
  const tlsHostRaw = FLAGS.get('tls-host') || '';
  const diskRaw = FLAGS.get('disk-path') || envStr('AGIL_DISK_PATH') || '';
  const skip = new Set(
    (FLAGS.get('skip') || '')
      .split(/[,\s]+/)
      .map((item) => item.trim())
      .filter(Boolean),
  );
  const knownGroups = new Set(['app', 'sfu', 'redis', 'tls', 'disk', 'mem', 'egress', 'docker']);
  for (const group of skip) {
    if (!knownGroups.has(group)) throw new Error(`unknown --skip group: ${group}`);
  }
  CONFIG = {
    timeout,
    slowMs: numFlag('slow-ms', 'AGIL_SLOW_MS', 1500, 100, 120000),
    appUrl: appUrlRaw,
    sfuUrls: sfuRaw ? sfuRaw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean) : [],
    redis: redisRaw,
    ssh: FLAGS.get('ssh') || envStr('AGIL_OPS_SSH'),
    redisContainer: FLAGS.get('redis-container') || envStr('AGIL_REDIS_CONTAINER'),
    tlsHost: tlsHostRaw,
    tlsPort: numFlag('tls-port', 'AGIL_TLS_PORT', 443, 1, 65535),
    diskPath: diskRaw,
    diskWarn: numFlag('disk-warn', 'AGIL_DISK_WARN_PCT', 80, 1, 100),
    diskCrit: numFlag('disk-crit', 'AGIL_DISK_CRIT_PCT', 90, 1, 100),
    memWarn: numFlag('mem-warn', 'AGIL_MEM_WARN_PCT', 85, 1, 100),
    memCrit: numFlag('mem-crit', 'AGIL_MEM_CRIT_PCT', 95, 1, 100),
    tlsWarnDays: numFlag('tls-warn-days', 'AGIL_TLS_WARN_DAYS', 21, 1, 365),
    tlsCritDays: numFlag('tls-crit-days', 'AGIL_TLS_CRIT_DAYS', 7, 0, 365),
    egressUrl: FLAGS.get('egress-url') || envStr('AGIL_EGRESS_HEALTH_URL'),
    dockerContainer: FLAGS.get('docker-container') || envStr('AGIL_DOCKER_CONTAINER'),
    expectProd: BOOLS.has('expect-prod'),
    allowAdminApi: BOOLS.has('allow-admin-api'),
    skip,
    json: BOOLS.has('json'),
    quiet: BOOLS.has('quiet'),
    envFileInfo,
  };
} catch (error) {
  console.error(`[FAIL] ${error.message}`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

const results = [];
const startedAt = Date.now();

function redactUrl(input) {
  try {
    const url = new URL(input);
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return String(input).replace(/\/\/[^/@]*@/, '//');
  }
}

function normalizeHttpUrl(input) {
  const trimmed = String(input).trim();
  if (/^wss:\/\//i.test(trimmed)) return `https://${trimmed.slice(6)}`;
  if (/^ws:\/\//i.test(trimmed)) return `http://${trimmed.slice(5)}`;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}

function hostOf(input) {
  try {
    return new URL(normalizeHttpUrl(input)).hostname;
  } catch {
    return '';
  }
}

function isLoopbackHost(host) {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0';
}

function truncate(value, max = 120) {
  const text = String(value ?? '');
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function sanitizeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  // Never echo credentials that might be embedded in a URL.
  return truncate(message.replace(/\/\/[^/@\s]*@/g, '//'), 200);
}

function parseHostPort(raw, fallbackHost, fallbackPort) {
  const value = String(raw ?? '').trim();
  if (!value) return { host: fallbackHost, port: fallbackPort };
  // Accept redis://host:port (including rediss://) as well as host:port.
  if (value.includes('://')) {
    try {
      const url = new URL(value);
      return { host: url.hostname, port: Number(url.port) || fallbackPort };
    } catch {
      /* fall through to the host:port parsers */
    }
  }
  // Accept host:port and [ipv6]:port.
  const ipv6 = value.match(/^\[([^\]]+)\]:(\d+)$/);
  if (ipv6) return { host: ipv6[1], port: Number(ipv6[2]) };
  const match = value.match(/^([^:]+):(\d+)$/);
  if (match) return { host: match[1], port: Number(match[2]) };
  return { host: value, port: fallbackPort };
}

async function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function record(id, group, status, summary, details = {}, durationMs = 0) {
  results.push({ id, group, status, summary, details, durationMs: Math.max(0, Math.round(durationMs)) });
}

async function guard(id, group, fn) {
  const start = Date.now();
  try {
    const outcome = await fn();
    if (outcome) record(id, group, outcome.status, outcome.summary, outcome.details, Date.now() - start);
  } catch (error) {
    record(id, group, 'crit', sanitizeError(error), { error: error?.code ?? 'error' }, Date.now() - start);
  }
}

function skipped(id, group, summary) {
  record(id, group, 'skip', summary, {});
}

// ---------------------------------------------------------------------------
// App health
// ---------------------------------------------------------------------------

function normalizeAppUrl(input) {
  const base = normalizeHttpUrl(input).replace(/\/+$/, '');
  return /\/v1\/health$/.test(base) ? base : `${base}/v1/health`;
}

async function checkApp() {
  const url = normalizeAppUrl(CONFIG.appUrl);
  const started = Date.now();
  let response;
  try {
    response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(CONFIG.timeout),
      headers: { accept: 'application/json', 'user-agent': 'agil-ops-check/1.0' },
    });
  } catch (error) {
    return { status: 'crit', summary: `health request failed: ${sanitizeError(error)}`, details: { url: redactUrl(url) } };
  }
  const latencyMs = Date.now() - started;
  const raw = await response.text();
  let body = null;
  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }
  const details = {
    url: redactUrl(url),
    status: response.status,
    latencyMs,
  };
  if (response.status >= 300 && response.status < 400) {
    return {
      status: 'warn',
      summary: `redirected (HTTP ${response.status}) to ${truncate(response.headers.get('location') ?? '?', 80)}; use the https URL`,
      details,
    };
  }
  if (response.status !== 200) {
    return {
      status: 'crit',
      summary: `health returned HTTP ${response.status} (${latencyMs} ms)`,
      details: { ...details, body: truncate(raw, 160) },
    };
  }
  if (!body || typeof body !== 'object') {
    return { status: 'crit', summary: 'health response is not JSON', details };
  }
  details.ok = body.ok;
  details.version = body.version;
  details.uptimeSec = body.uptimeSec;
  details.rooms = body.rooms;
  details.tenants = body.tenants;
  const security = body.security && typeof body.security === 'object' ? body.security : {};
  details.mediaMode = security.mediaMode;
  details.docsEnabled = security.docsEnabled;
  details.adminApiEnabled = security.adminApiEnabled;
  details.mcpHttpEnabled = security.mcpHttpEnabled;
  details.scaleConfigured = security.scaleConfigured;

  if (body.ok !== true) {
    return { status: 'crit', summary: 'health responded 200 but ok !== true', details };
  }

  const warnings = [];
  if (latencyMs > CONFIG.slowMs) warnings.push(`slow response ${latencyMs} ms`);
  if (Number.isFinite(body.uptimeSec) && body.uptimeSec < 120) warnings.push(`recently restarted (uptime ${body.uptimeSec}s)`);
  if (CONFIG.expectProd) {
    if (security.docsEnabled) warnings.push('docs are publicly enabled');
    if (security.mcpHttpEnabled) warnings.push('MCP HTTP is enabled');
    if (security.adminApiEnabled && !CONFIG.allowAdminApi) warnings.push('admin API is enabled (check the allowlist)');
  }
  if (body.rooms === 0 && Number(body.uptimeSec) > 3600) {
    // Informational only: an idle installation is normal outside business hours.
    details.note = 'no active rooms';
  }

  if (warnings.length > 0) {
    return { status: 'warn', summary: `ok=true, ${warnings.join('; ')}`, details };
  }
  return {
    status: 'ok',
    summary: `ok=true in ${latencyMs} ms (rooms=${body.rooms ?? '?'}, tenants=${body.tenants ?? '?'}, mode=${security.mediaMode ?? '?'})`,
    details,
  };
}

// ---------------------------------------------------------------------------
// SFU nodes
// ---------------------------------------------------------------------------

async function checkSfuNode(rawUrl) {
  const url = normalizeHttpUrl(rawUrl).replace(/\/+$/, '');
  const started = Date.now();
  let response;
  try {
    response = await fetch(`${url}/`, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(CONFIG.timeout),
      headers: { accept: 'text/plain', 'user-agent': 'agil-ops-check/1.0' },
    });
  } catch (error) {
    return { status: 'crit', summary: `unreachable: ${sanitizeError(error)}`, details: { url: redactUrl(url) } };
  }
  const latencyMs = Date.now() - started;
  const body = (await response.text()).trim();
  const details = { url: redactUrl(url), status: response.status, latencyMs, body: truncate(body, 40) };
  if (response.status !== 200) {
    return { status: 'crit', summary: `HTTP ${response.status} (${latencyMs} ms)`, details };
  }
  if (!/^OK\b/i.test(body)) {
    return { status: 'warn', summary: `HTTP 200 but unexpected body "${truncate(body, 24)}"`, details };
  }
  if (latencyMs > CONFIG.slowMs) {
    return { status: 'warn', summary: `OK but slow (${latencyMs} ms)`, details };
  }
  return { status: 'ok', summary: `OK in ${latencyMs} ms`, details };
}

// ---------------------------------------------------------------------------
// Redis PING (read-only)
// ---------------------------------------------------------------------------

function execFileAsync(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const detail = sanitizeError(stderr?.trim() || error.message);
        reject(new Error(`${command} failed: ${detail}`));
        return;
      }
      resolve(String(stdout ?? ''));
    });
  });
}

function tcpRedisPing(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    let buffer = '';
    let settled = false;
    const finish = (error, reply) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(reply);
    };
    socket.setTimeout(timeoutMs, () => finish(new Error(`Redis PING timed out after ${timeoutMs} ms`)));
    socket.on('error', (error) => finish(error));
    socket.on('connect', () => socket.write('PING\r\n'));
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.includes('\r\n')) {
        finish(null, buffer.split('\r\n')[0]);
      }
    });
    socket.on('close', () => {
      if (!settled) finish(new Error('Redis closed the connection before replying'));
    });
  });
}

async function checkRedis() {
  if (!CONFIG.redis && !CONFIG.ssh) {
    return { status: 'skip', summary: 'not configured (pass --redis or AGIL_REDIS_ADDRESS)', details: {} };
  }
  const { host, port } = parseHostPort(CONFIG.redis, '127.0.0.1', 6379);
  const details = { host, port, via: 'tcp' };
  let reply = '';

  if (CONFIG.ssh) {
    if (!/^[A-Za-z0-9_.@:-]+$/.test(CONFIG.ssh)) throw new Error('invalid --ssh target characters');
    if (CONFIG.redisContainer && !/^[A-Za-z0-9_.-]+$/.test(CONFIG.redisContainer)) {
      throw new Error('invalid --redis-container name');
    }
    if (!/^[A-Za-z0-9_.:-]+$/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('invalid Redis host/port');
    }
    const remote = CONFIG.redisContainer
      ? `docker exec ${CONFIG.redisContainer} redis-cli PING`
      : `redis-cli -h ${host} -p ${port} PING`;
    details.via = CONFIG.redisContainer ? `ssh:docker exec ${CONFIG.redisContainer}` : 'ssh:redis-cli';
    try {
      reply = (await execFileAsync(
        'ssh',
        ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', CONFIG.ssh, remote],
        CONFIG.timeout + 5000,
      )).trim();
    } catch (error) {
      return { status: 'crit', summary: sanitizeError(error), details };
    }
  } else {
    try {
      reply = await withTimeout(tcpRedisPing(host, port, CONFIG.timeout), CONFIG.timeout + 500, 'Redis PING');
    } catch (error) {
      return { status: 'crit', summary: sanitizeError(error), details };
    }
  }

  if (/^\+?PONG\b/i.test(reply)) {
    return { status: 'ok', summary: `PONG via ${details.via}`, details: { ...details, reply: '+PONG' } };
  }
  if (/^\-NOAUTH\b/i.test(reply)) {
    return {
      status: 'warn',
      summary: 'Redis requires authentication; TCP is reachable but PING was refused (use redis-cli with REDISCLI_AUTH)',
      details: { ...details, reply: '-NOAUTH' },
    };
  }
  if (/^\-ERR\b/i.test(reply) || /unknown command/i.test(reply)) {
    return { status: 'warn', summary: `unexpected Redis reply: ${truncate(reply, 60)}`, details };
  }
  return { status: 'crit', summary: `unhealthy Redis reply: ${truncate(reply || 'empty', 60)}`, details };
}

// ---------------------------------------------------------------------------
// TLS / domain
// ---------------------------------------------------------------------------

function tlsHandshake(host, port, rejectUnauthorized, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      { host, port, servername: host, rejectUnauthorized, timeout: timeoutMs, ALPNProtocols: ['http/1.1'] },
      () => {
        const cert = socket.getPeerCertificate(false) ?? {};
        const result = {
          authorized: socket.authorized,
          authorizationError: socket.authorizationError ? String(socket.authorizationError) : null,
          protocol: socket.getProtocol(),
          cert: {
            subject: cert.subject?.CN ?? '',
            issuer: cert.issuer?.CN ?? cert.issuer?.O ?? '',
            validFrom: cert.valid_from ?? '',
            validTo: cert.valid_to ?? '',
            subjectAltName: cert.subjectaltname ?? '',
          },
        };
        socket.destroy();
        resolve(result);
      },
    );
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      reject(new Error(`TLS handshake to ${host}:${port} timed out after ${timeoutMs} ms`));
    });
    socket.on('error', (error) => {
      socket.destroy();
      reject(error);
    });
  });
}

function daysUntil(dateString) {
  const timestamp = Date.parse(dateString);
  if (!Number.isFinite(timestamp)) return null;
  return Math.floor((timestamp - Date.now()) / 86400000);
}

async function resolveHost(host, timeoutMs) {
  try {
    const addresses = await withTimeout(dns.promises.lookup(host, { all: true }), timeoutMs, 'DNS lookup');
    return addresses.map((entry) => entry.address);
  } catch {
    return [];
  }
}

function deriveTlsHost() {
  if (CONFIG.tlsHost) return CONFIG.tlsHost;
  const host = hostOf(CONFIG.appUrl);
  if (!host || isLoopbackHost(host) || net.isIP(host)) return '';
  try {
    const app = new URL(normalizeHttpUrl(CONFIG.appUrl));
    return app.protocol === 'https:' ? app.hostname : '';
  } catch {
    return '';
  }
}

async function checkTls() {
  const host = deriveTlsHost();
  if (!host) {
    return { status: 'skip', summary: 'not configured (app URL is not https; pass --tls-host)', details: {} };
  }
  const port = CONFIG.tlsPort;
  const addresses = await resolveHost(host, CONFIG.timeout);
  const details = { host, port, addresses: addresses.slice(0, 4) };
  if (addresses.length === 0) {
    return { status: 'crit', summary: `${host} does not resolve`, details };
  }

  let loose;
  try {
    loose = await tlsHandshake(host, port, false, CONFIG.timeout);
  } catch (error) {
    return { status: 'crit', summary: `TLS handshake failed: ${sanitizeError(error)}`, details };
  }
  const daysLeft = daysUntil(loose.cert.validTo);
  details.daysLeft = daysLeft;
  details.notAfter = loose.cert.validTo;
  details.issuer = loose.cert.issuer;
  details.protocol = loose.protocol;

  let strict = null;
  let strictError = null;
  try {
    strict = await tlsHandshake(host, port, true, CONFIG.timeout);
  } catch (error) {
    strictError = sanitizeError(error);
  }
  details.authorized = strict ? strict.authorized : false;
  if (strictError) details.authorizationError = strictError;

  if (daysLeft === null) {
    return { status: 'warn', summary: 'certificate expiry could not be parsed', details };
  }
  if (daysLeft < 0) {
    return { status: 'crit', summary: `certificate expired ${Math.abs(daysLeft)} day(s) ago`, details };
  }
  if (strictError || (strict && !strict.authorized)) {
    return {
      status: 'crit',
      summary: `certificate is not trusted for ${host}: ${truncate(strictError ?? 'authorization failed', 120)}`,
      details,
    };
  }
  if (daysLeft < CONFIG.tlsCritDays) {
    return { status: 'crit', summary: `certificate expires in ${daysLeft} day(s)`, details };
  }
  if (daysLeft < CONFIG.tlsWarnDays) {
    return { status: 'warn', summary: `certificate expires in ${daysLeft} day(s)`, details };
  }
  return { status: 'ok', summary: `valid, expires in ${daysLeft} day(s)`, details };
}

// ---------------------------------------------------------------------------
// Disk / memory
// ---------------------------------------------------------------------------

async function checkDisk() {
  let target = CONFIG.diskPath;
  if (!target) {
    const dataDir = envStr('AGIL_DATA_DIR');
    target = dataDir ? path.resolve(REPO_ROOT, dataDir) : '/';
  }
  if (!path.isAbsolute(target)) target = path.resolve(REPO_ROOT, target);
  let stats;
  try {
    stats = await fs.statfs(target);
  } catch (error) {
    return {
      status: 'crit',
      summary: `cannot stat filesystem for ${target}: ${sanitizeError(error)}`,
      details: { path: target },
    };
  }
  const totalBytes = Number(stats.bsize) * Number(stats.blocks);
  const availBytes = Number(stats.bsize) * Number(stats.bavail);
  if (!totalBytes) {
    return { status: 'warn', summary: `filesystem size unavailable for ${target}`, details: { path: target } };
  }
  const usedPct = Math.round(((totalBytes - availBytes) / totalBytes) * 1000) / 10;
  const details = {
    path: target,
    totalBytes,
    availBytes,
    usedPct,
    warnPct: CONFIG.diskWarn,
    critPct: CONFIG.diskCrit,
  };
  if (usedPct >= CONFIG.diskCrit) {
    return { status: 'crit', summary: `${usedPct}% used on ${target} (>= ${CONFIG.diskCrit}%)`, details };
  }
  if (usedPct >= CONFIG.diskWarn) {
    return { status: 'warn', summary: `${usedPct}% used on ${target} (>= ${CONFIG.diskWarn}%)`, details };
  }
  return { status: 'ok', summary: `${usedPct}% used on ${target}`, details };
}

async function readFirstExisting(paths) {
  for (const candidate of paths) {
    try {
      const raw = await fs.readFile(candidate, 'utf8');
      return { path: candidate, value: raw.trim() };
    } catch {
      /* try next */
    }
  }
  return null;
}

async function checkMemory() {
  const details = { warnPct: CONFIG.memWarn, critPct: CONFIG.memCrit };
  const maxFile = await readFirstExisting([
    '/sys/fs/cgroup/memory.max',
    '/sys/fs/cgroup/memory/memory.limit_in_bytes',
  ]);
  const currentFile = await readFirstExisting([
    '/sys/fs/cgroup/memory.current',
    '/sys/fs/cgroup/memory/memory.usage_in_bytes',
  ]);
  if (maxFile && currentFile && maxFile.value !== 'max') {
    const limit = Number(maxFile.value);
    const used = Number(currentFile.value);
    // A cgroup v1 "unlimited" sentinel is greater than the host's RAM; treat it
    // as "no container limit" and fall back to host memory.
    const unlimited = Number.isFinite(limit) && limit > os.totalmem() * 1.5;
    if (Number.isFinite(limit) && limit > 0 && Number.isFinite(used) && !unlimited) {
      const usedPct = Math.round((used / limit) * 1000) / 10;
      Object.assign(details, {
        source: 'cgroup',
        limitBytes: limit,
        usedBytes: used,
        usedPct,
        limitSource: maxFile.path,
      });
      if (usedPct >= CONFIG.memCrit) {
        return { status: 'crit', summary: `container memory ${usedPct}% of limit (>= ${CONFIG.memCrit}%)`, details };
      }
      if (usedPct >= CONFIG.memWarn) {
        return { status: 'warn', summary: `container memory ${usedPct}% of limit (>= ${CONFIG.memWarn}%)`, details };
      }
      return { status: 'ok', summary: `container memory ${usedPct}% of limit`, details };
    }
  }

  const total = os.totalmem();
  const free = os.freemem();
  const usedPct = Math.round(((total - free) / total) * 1000) / 10;
  Object.assign(details, { source: 'host', limitBytes: total, usedBytes: total - free, usedPct });
  if (usedPct >= CONFIG.memCrit) {
    return { status: 'crit', summary: `host memory ${usedPct}% used (>= ${CONFIG.memCrit}%)`, details };
  }
  if (usedPct >= CONFIG.memWarn) {
    return { status: 'warn', summary: `host memory ${usedPct}% used (>= ${CONFIG.memWarn}%)`, details };
  }
  return { status: 'ok', summary: `host memory ${usedPct}% used`, details };
}

// ---------------------------------------------------------------------------
// Egress / docker (optional)
// ---------------------------------------------------------------------------

async function checkEgress() {
  if (!CONFIG.egressUrl) {
    return { status: 'skip', summary: 'not configured (pass --egress-url http://127.0.0.1:8080/)', details: {} };
  }
  const url = normalizeHttpUrl(CONFIG.egressUrl).replace(/\/+$/, '');
  const started = Date.now();
  let response;
  try {
    response = await fetch(`${url}/`, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(CONFIG.timeout),
      headers: { accept: 'application/json', 'user-agent': 'agil-ops-check/1.0' },
    });
  } catch (error) {
    return { status: 'crit', summary: `egress health request failed: ${sanitizeError(error)}`, details: { url: redactUrl(url) } };
  }
  const latencyMs = Date.now() - started;
  const raw = await response.text();
  let body = null;
  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }
  const details = { url: redactUrl(url), status: response.status, latencyMs };
  if (response.status !== 200) {
    return { status: 'crit', summary: `egress health returned HTTP ${response.status}`, details };
  }
  if (!body) {
    return { status: 'warn', summary: 'egress health is not JSON', details: { ...details, body: truncate(raw, 80) } };
  }
  details.keys = Object.keys(body).slice(0, 8);
  const busy = body.active ?? body.activeCount ?? body.jobs;
  if (typeof busy === 'number') details.active = busy;
  if (latencyMs > CONFIG.slowMs) {
    return { status: 'warn', summary: `egress health slow (${latencyMs} ms)`, details };
  }
  return { status: 'ok', summary: `egress health OK in ${latencyMs} ms`, details };
}

async function checkDocker() {
  if (!CONFIG.dockerContainer) {
    return { status: 'skip', summary: 'not configured (pass --docker-container agil-calls)', details: {} };
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(CONFIG.dockerContainer)) throw new Error('invalid --docker-container name');
  let raw;
  try {
    raw = await execFileAsync('docker', ['inspect', '-f', '{{json .State}}', CONFIG.dockerContainer], CONFIG.timeout);
  } catch (error) {
    return { status: 'crit', summary: `docker inspect failed: ${sanitizeError(error)}`, details: { container: CONFIG.dockerContainer } };
  }
  let state;
  try {
    state = JSON.parse(raw);
  } catch {
    return { status: 'warn', summary: 'could not parse docker inspect output', details: { container: CONFIG.dockerContainer } };
  }
  const details = {
    container: CONFIG.dockerContainer,
    status: state.Status,
    running: Boolean(state.Running),
    restartCount: state.RestartCount ?? 0,
    health: state.Health?.Status ?? 'n/a',
    oomKilled: Boolean(state.OOMKilled),
  };
  if (!details.running) {
    return { status: 'crit', summary: `container is ${details.status ?? 'not running'}`, details };
  }
  if (details.health === 'unhealthy') {
    return { status: 'crit', summary: 'container healthcheck reports unhealthy', details };
  }
  if (details.oomKilled) {
    return { status: 'crit', summary: 'container was OOM-killed', details };
  }
  if (details.restartCount > 0 && details.status === 'restarting') {
    return { status: 'crit', summary: `container is restarting (${details.restartCount} restarts)`, details };
  }
  if (details.restartCount > 0) {
    return { status: 'warn', summary: `container has restarted ${details.restartCount} time(s)`, details };
  }
  return { status: 'ok', summary: `running, health=${details.health}`, details };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const CHECKS = [];
if (!CONFIG.skip.has('app')) CHECKS.push(['app.health', 'app', checkApp]);
if (!CONFIG.skip.has('sfu')) CHECKS.push(['sfu.nodes', 'sfu', null]);
if (!CONFIG.skip.has('redis')) CHECKS.push(['redis.ping', 'redis', checkRedis]);
if (!CONFIG.skip.has('tls')) CHECKS.push(['tls.domain', 'tls', checkTls]);
if (!CONFIG.skip.has('disk')) CHECKS.push(['disk', 'disk', checkDisk]);
if (!CONFIG.skip.has('mem')) CHECKS.push(['memory', 'mem', checkMemory]);
if (!CONFIG.skip.has('egress')) CHECKS.push(['egress.health', 'egress', checkEgress]);
if (!CONFIG.skip.has('docker')) CHECKS.push(['docker.container', 'docker', checkDocker]);

for (const [id, group, fn] of CHECKS) {
  if (id === 'sfu.nodes') {
    if (CONFIG.sfuUrls.length === 0) {
      skipped('sfu.nodes', 'sfu', 'not configured (pass --sfu or AGIL_SFU_NODES / AGIL_SFU_URL)');
      continue;
    }
    for (const [index, url] of CONFIG.sfuUrls.entries()) {
      await guard(`sfu.node${index + 1}`, 'sfu', () => checkSfuNode(url));
    }
    continue;
  }
  await guard(id, group, fn);
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const SEVERITY = { crit: 2, warn: 1, ok: 0, skip: 0 };
const counts = { ok: 0, warn: 0, crit: 0, skip: 0 };
let worst = 0;
for (const item of results) {
  counts[item.status] = (counts[item.status] ?? 0) + 1;
  worst = Math.max(worst, SEVERITY[item.status] ?? 0);
}
const statusLabel = worst === 2 ? 'crit' : worst === 1 ? 'warn' : 'ok';
const payload = {
  ok: worst === 0,
  status: statusLabel,
  tool: 'agil/core/scripts/ops-check.mjs',
  checkedAt: new Date().toISOString(),
  durationMs: Date.now() - startedAt,
  target: {
    app: redactUrl(normalizeAppUrl(CONFIG.appUrl)),
    sfu: CONFIG.sfuUrls.map((item) => redactUrl(normalizeHttpUrl(item))),
    redis: CONFIG.redis ? `${parseHostPort(CONFIG.redis, '127.0.0.1', 6379).host}:${parseHostPort(CONFIG.redis, '127.0.0.1', 6379).port}` : null,
    tlsHost: deriveTlsHost() || null,
    diskPath: results.find((item) => item.id === 'disk')?.details?.path ?? CONFIG.diskPath ?? null,
    egress: CONFIG.egressUrl ? redactUrl(normalizeHttpUrl(CONFIG.egressUrl)) : null,
    docker: CONFIG.dockerContainer || null,
    envFile: CONFIG.envFileInfo ? path.basename(CONFIG.envFileInfo.file) : null,
  },
  counts,
  checks: results,
};

if (CONFIG.json) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
} else if (!CONFIG.quiet) {
  const width = Math.max(...results.map((item) => item.id.length), 10);
  console.log(`AgilFrame ops check — ${payload.checkedAt}`);
  console.log(`  app: ${payload.target.app}`);
  if (payload.target.sfu.length) console.log(`  sfu: ${payload.target.sfu.join(', ')}`);
  if (payload.target.redis) console.log(`  redis: ${payload.target.redis}`);
  if (payload.target.tlsHost) console.log(`  tls: ${payload.target.tlsHost}:${CONFIG.tlsPort}`);
  console.log('');
  for (const item of results) {
    const label = item.status.toUpperCase().padEnd(4);
    console.log(`  [${label}] ${item.id.padEnd(width)}  ${item.summary}`);
    if (item.status !== 'ok' && item.details && Object.keys(item.details).length > 0) {
      const extra = Object.entries(item.details)
        .filter(([, value]) => value !== null && value !== undefined && typeof value !== 'object')
        .slice(0, 4)
        .map(([key, value]) => `${key}=${value}`)
        .join(' ');
      if (extra) console.log(`           ${extra}`);
    }
  }
  console.log('');
  console.log(
    `${counts.ok} ok, ${counts.warn} warn, ${counts.crit} crit, ${counts.skip} skip -> exit ${worst}`,
  );
}

process.exitCode = worst;
