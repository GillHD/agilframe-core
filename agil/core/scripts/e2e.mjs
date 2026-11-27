#!/usr/bin/env node
/**
 * AgilFrame end-to-end check (headless Chrome/Edge).
 *
 *   node scripts/e2e.mjs [--headed] [--keep] [--only=api|browser]
 *
 * Requires a prior `npm run build`. Starts the built server on PORT 8899 with a
 * throwaway data dir, checks the REST/security API, then opens two headless
 * pages with fake media devices, joins the same room and verifies:
 *   - both participants see each other (2 video tiles, data-state="joined"),
 *   - chat message round-trips and is visible on both sides,
 *   - the server-provided theme is applied to the widget root (CSS vars),
 *   - quality/connection indicators are present.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import puppeteer from 'puppeteer-core';

const ROOT = process.cwd();
const PORT = Number(process.env.E2E_PORT || 8899);
const BASE = `http://127.0.0.1:${PORT}`;
const args = new Set(process.argv.slice(2));
const HEADED = args.has('--headed');
const KEEP = args.has('--keep');
const ONLY = [...args].find((a) => a.startsWith('--only='))?.split('=')[1] ?? 'all';

const results = [];
let failures = 0;

function check(name, ok, details = '') {
  results.push({ name, ok, details });
  if (ok) {
    console.log(`  \x1b[32m✔\x1b[0m ${name}${details ? ` — ${details}` : ''}`);
  } else {
    failures += 1;
    console.log(`  \x1b[31m✖\x1b[0m ${name}${details ? ` — ${details}` : ''}`);
  }
}

async function waitFor(fn, { timeoutMs = 15000, intervalMs = 250, label = 'condition' } = {}) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timeout waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

function findBrowser() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

async function apiFetch(url, options = {}) {
  const response = await fetch(`${BASE}${url}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

function startServer(dataDir) {
  const entry = path.join(ROOT, 'agil', 'core', 'apps', 'server', 'dist', 'index.js');
  if (!existsSync(entry)) {
    throw new Error(`server build missing: ${entry}. Run \`npm run build\` first.`);
  }
  const child = spawn(process.execPath, [entry], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(PORT),
      AGIL_ALLOW_ANONYMOUS: '1',
      AGIL_DATA_DIR: dataDir,
      AGIL_TOKEN_SECRET: 'e2e-secret',
      AGIL_API_KEYS: 'dev-key:demo',
      AGIL_PUBLIC_ORIGIN: BASE,
      AGIL_TRUST_PROXY: '1',
      AGIL_GEO_PROVIDER: 'header',
      AGIL_IP_SALT: 'e2e-salt',
      AGIL_STATIC_DIR: path.join(ROOT, 'agil', 'websdk', 'demo', 'dist'),
      AGIL_EDITOR_DIR: path.join(ROOT, 'agil', 'core', 'apps', 'editor', 'dist'),
      AGIL_DASHBOARD_DIR: path.join(ROOT, 'agil', 'core', 'apps', 'dashboard', 'dist'),
      AGIL_SDK_DIR: path.join(ROOT, 'agil', 'websdk', 'sdk', 'dist'),
      AGIL_WIDGET_DIR: path.join(ROOT, 'agil', 'websdk', 'widget', 'dist'),
      AGIL_ICE_SERVERS: JSON.stringify([{ urls: 'stun:stun.l.google.com:19302' }]),
      NODE_ENV: 'test',
    },
  });
  child.stdout.on('data', (chunk) => process.env.E2E_VERBOSE && process.stdout.write(`[server] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[server:err] ${chunk}`));
  return child;
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill();
    setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      resolve();
    }, 4000);
  });
}

async function runApiChecks() {
  console.log('\nAPI / security');
  const health = await apiFetch('/v1/health');
  check('GET /v1/health → ok', health.status === 200 && health.body?.ok === true, `status ${health.status}`);

  const config = await apiFetch('/v1/tenants/demo/config');
  check(
    'GET tenant config is public and valid',
    config.status === 200 && typeof config.body?.config?.theme?.colors?.primary === 'string',
    `primary=${config.body?.config?.theme?.colors?.primary}`,
  );

  const created = await apiFetch('/v1/rooms', {
    method: 'POST',
    body: JSON.stringify({ tenantId: 'demo', name: 'E2E room' }),
  });
  check(
    'POST /v1/rooms (anonymous) returns token + embedUrl',
    created.status === 200 && typeof created.body?.token === 'string' && typeof created.body?.embedUrl === 'string',
    `status ${created.status}`,
  );
  const room = created.body?.room;
  const token = created.body?.token;

  const adminRoom = await apiFetch('/v1/admin/rooms', {
    method: 'POST',
    headers: { 'x-api-key': 'dev-key' },
    body: JSON.stringify({ tenantId: 'demo', name: 'E2E secured', password: 'pass123', maxParticipants: 4 }),
  });
  check(
    'admin creates password-protected room (hash never exposed)',
    adminRoom.status === 200 &&
      adminRoom.body?.passwordProtected === true &&
      !JSON.stringify(adminRoom.body).includes('pass123'),
    `status ${adminRoom.status}`,
  );
  const securedId = adminRoom.body?.room?.id;

  if (securedId) {
    const denied = await apiFetch(`/v1/rooms/${securedId}/join`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Intruder', password: 'wrong' }),
    });
    check(
      'join with wrong password denied',
      denied.status === 401 || denied.status === 403,
      `status ${denied.status} code=${denied.body?.error?.code}`,
    );

    const joined = await apiFetch(`/v1/rooms/${securedId}/join`, {
      method: 'POST',
      headers: { 'x-forwarded-for': '203.0.113.7', 'x-agil-country': 'RU' },
      body: JSON.stringify({ name: 'Alisa', password: 'pass123' }),
    });
    check(
      'join with correct password returns a token',
      joined.status === 200 && typeof joined.body?.token === 'string',
      `status ${joined.status}`,
    );

    const overview = await apiFetch('/v1/admin/overview', { headers: { 'x-api-key': 'dev-key' } });
    check(
      'admin overview reports active rooms',
      overview.status === 200 && (overview.body?.totalRoomsCreated ?? 0) >= 1,
      `rooms=${overview.body?.totalRoomsCreated}`,
    );

    const audit = await apiFetch('/v1/admin/audit?limit=20', { headers: { 'x-api-key': 'dev-key' } });
    const auditText = JSON.stringify(audit.body ?? {});
    check(
      'audit log contains join + password events',
      audit.status === 200 && auditText.includes('join.allowed') && auditText.includes('password.failed'),
      `entries=${Array.isArray(audit.body?.entries) ? audit.body.entries.length : 0}`,
    );
  }

  const invite = await apiFetch(`/v1/admin/rooms/${room?.id ?? 'missing'}/invites`, {
    method: 'POST',
    headers: { 'x-api-key': 'dev-key' },
    body: JSON.stringify({ ttlSec: 600 }),
  });
  check(
    'admin invite link',
    invite.status === 200 && typeof invite.body?.joinUrl === 'string' && typeof invite.body?.token === 'string',
    `status ${invite.status}`,
  );

  // File upload is gated by the tenant feature flag (F-03): enable it for the
  // demo tenant before the file checks (normal product behaviour).
  await apiFetch('/v1/tenants/demo/config', {
    method: 'PATCH',
    headers: { 'x-api-key': 'dev-key' },
    body: JSON.stringify({ features: { fileShare: true } }),
  });
  const fileUpload = await fetch(`${BASE}/v1/files`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'text/plain',
      'x-file-name': encodeURIComponent('e2e.txt'),
    },
    body: 'hello AgilFrame',
  });
  const fileBody = await fileUpload.json().catch(() => null);
  check(
    'file upload with join token',
    fileUpload.status === 200 && typeof fileBody?.url === 'string',
    `status ${fileUpload.status}`,
  );
  if (fileBody?.url) {
    const download = await fetch(fileBody.url);
    const text = await download.text();
    check('file download via signed URL', download.status === 200 && text === 'hello AgilFrame', `status ${download.status}`);
  }

  return { room, token };
}

async function runBrowserChecks(room, token) {
  console.log('\nBrowser (2 participants, fake media)');
  const executablePath = findBrowser();
  if (!executablePath) throw new Error('Chrome/Edge not found; set CHROME_PATH');

  // Each participant must have an OWN token: reusing one token is treated by the
  // signaling layer as a reconnect and replaces the previous participant.
  const second = await apiFetch('/v1/tokens', {
    method: 'POST',
    headers: { 'x-api-key': 'dev-key' },
    body: JSON.stringify({ tenantId: 'demo', roomId: room.id, participant: { name: 'Bob', role: 'guest' } }),
  });
  const bobToken = second.body?.token ?? token;
  check('second participant gets its own token', typeof second.body?.token === 'string', `status ${second.status}`);

  const dataDir = mkdtempSync(path.join(tmpdir(), 'agil-e2e-profile-'));
  const browser = await puppeteer.launch({
    executablePath,
    headless: !HEADED ? 'new' : false,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${dataDir}`,
    ],
  });

  const openPage = async (name, pageToken) => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    page.on('console', (message) => {
      if (process.env.E2E_VERBOSE) console.log(`[${name}:console] ${message.type()}: ${message.text()}`);
    });
    page.on('pageerror', (error) => console.log(`[${name}:pageerror] ${error.message}`));
    const url = `${BASE}/embed.html?room=${encodeURIComponent(room.id)}&token=${encodeURIComponent(pageToken)}&tenant=demo&name=${encodeURIComponent(name)}&theme=auto`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await waitFor(
      async () => {
        const state = await page.$eval('[data-agil-root]', (el) => el.getAttribute('data-state')).catch(() => null);
        return state === 'joined';
      },
      { timeoutMs: 30000, label: `${name} joined` },
    );
    return page;
  };

  const alice = await openPage('Alice', token);
  const bob = await openPage('Bob', bobToken);

  const tileCount = (page) =>
    page.$$eval('[data-agil-tile]', (tiles) => tiles.length).catch(() => 0);
  const participantsCount = (page) =>
    page
      .$eval('[data-agil-participants-count]', (el) => Number(el.textContent?.match(/\d+/)?.[0] ?? 0))
      .catch(() => 0);

  const bothSeeTwo = await waitFor(
    async () => (await tileCount(alice)) >= 2 && (await tileCount(bob)) >= 2,
    { timeoutMs: 30000, label: 'two tiles on both sides' },
  ).then(() => true).catch(() => false);
  check('both participants see 2 tiles', bothSeeTwo, `alice=${await tileCount(alice)} bob=${await tileCount(bob)}`);

  check(
    'participant counters show 2',
    (await participantsCount(alice)) === 2 && (await participantsCount(bob)) === 2,
    `alice=${await participantsCount(alice)} bob=${await participantsCount(bob)}`,
  );

  const remoteVideoPlays = await waitFor(() => alice.evaluate(() => {
    const videos = Array.from(document.querySelectorAll('[data-agil-tile][data-self="false"] video'));
    if (!videos.length) return false;
    return videos.some((video) => video.videoWidth > 0 || video.readyState >= 2);
  }), { timeoutMs: 15000, label: 'first remote video frame' }).then(() => true).catch(() => false);
  check('remote video element receives a frame', remoteVideoPlays);

  const scheme = await alice.$eval('[data-agil-root]', (el) => el.getAttribute('data-agil-scheme')).catch(() => null);
  const primary = await alice.evaluate(() => {
    const root = document.querySelector('[data-agil-root]');
    return root ? getComputedStyle(root).getPropertyValue('--agil-color-primary').trim() : '';
  });
  check('theme tokens applied to widget root', Boolean(scheme) && /^#/.test(primary), `scheme=${scheme} primary=${primary}`);

  // chat: open panel, send from Alice, expect it on Bob
  const chatOpened = await alice.evaluate(() => {
    const button = document.querySelector('[data-agil-action="chat"]');
    if (button) button.click();
    return Boolean(button);
  });
  const text = `e2e-hello-${Date.now()}`;
  const sent = await alice.evaluate((message) => {
    const input = document.querySelector('[data-agil-chat-input]');
    if (!input) return false;
    input.focus();
    input.value = message;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const send = document.querySelector('[data-agil-chat-send]');
    if (send) send.click();
    else input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  }, text);
  check('chat panel opens and message is sent', chatOpened && sent);
  if (chatOpened && sent) {
    const delivered = await waitFor(
      async () => {
        const html = await bob.content();
        return html.includes(text);
      },
      { timeoutMs: 15000, label: 'chat delivered to Bob' },
    )
      .then(() => true)
      .catch(() => false);
    check('chat message delivered to the other participant', delivered);
  }

  const quality = await alice.$eval('[data-agil-root]', (el) => el.getAttribute('data-agil-quality')).catch(() => null);
  check('quality indicator attribute present', Boolean(quality), `quality=${quality}`);

  // leave cleanly
  await alice.evaluate(() => document.querySelector('[data-agil-action="leave"]')?.click()).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const bobSeesOne = (await tileCount(bob)) <= 1;
  check('peer-left is reflected on the other side', bobSeesOne, `bob tiles=${await tileCount(bob)}`);

  await browser.close();
  if (!KEEP) rmSync(dataDir, { recursive: true, force: true });
}

async function main() {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'agil-e2e-data-'));
  console.log(`AgilFrame e2e — server ${BASE}, data ${dataDir}`);
  let server = null;
  try {
    server = startServer(dataDir);
    await waitFor(async () => {
      try {
        const response = await fetch(`${BASE}/v1/health`);
        return response.ok;
      } catch {
        return false;
      }
    }, { timeoutMs: 20000, label: 'server health' });
    console.log('  server is up');

    let context = null;
    if (ONLY !== 'browser') context = await runApiChecks();
    if (ONLY !== 'api') {
      const room = context?.room ?? (await apiFetch('/v1/rooms', { method: 'POST', body: JSON.stringify({ tenantId: 'demo', name: 'E2E chat' }) })).body?.room;
      const token = context?.token ?? (await apiFetch('/v1/rooms', { method: 'POST', body: JSON.stringify({ tenantId: 'demo', name: 'E2E chat2' }) })).body?.token;
      const roomForBrowser = context?.room ?? room;
      await runBrowserChecks(roomForBrowser, token);
    }
  } catch (error) {
    failures += 1;
    console.error(`\n\x1b[31mE2E failed:\x1b[0m ${error.stack ?? error.message}`);
  } finally {
    await stopServer(server);
    if (!KEEP) rmSync(dataDir, { recursive: true, force: true });
  }

  console.log(`\nИтог: ${results.length - failures}/${results.length} проверок пройдено`);
  if (failures > 0) {
    console.log('Провалено:');
    for (const result of results.filter((r) => !r.ok)) console.log(`  - ${result.name}${result.details ? ` (${result.details})` : ''}`);
    process.exitCode = 1;
  }
}

await main();
