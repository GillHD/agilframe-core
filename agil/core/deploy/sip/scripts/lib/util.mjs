/**
 * Local SIP lab — tiny shared helpers (no dependencies).
 *
 * The lab scripts target a *running* stack (docker compose up) plus a running
 * AgilFrame server with `AGIL_SIP_*` env; they never start or stop containers
 * themselves except for the optional `--service-down` check.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls `fn` until it returns a truthy value or the timeout expires. */
export async function poll(fn, { timeoutMs = 30000, intervalMs = 250, label = 'condition' } = {}) {
  const started = Date.now();
  let lastError = null;
  let lastValue;
  while (Date.now() - started < timeoutMs) {
    try {
      lastValue = await fn();
      if (lastValue) return lastValue;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  const detail = lastError ? `: ${lastError.message}` : '';
  throw new Error(`timeout after ${timeoutMs} ms waiting for ${label}${detail}`);
}

/** JSON HTTP call with a hard timeout; returns `{ status, body, text, headers }`. */
export async function httpJson(url, { method = 'GET', headers = {}, body, timeoutMs = 10000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    return { status: response.status, body: parsed, text, headers: response.headers };
  } finally {
    clearTimeout(timer);
  }
}

/** Minimal assertion helper: prints the failed check and throws. */
export function check(condition, message) {
  if (!condition) throw new Error(`check failed: ${message}`);
  return true;
}

/** Files in `dir` whose basename starts with `prefix` (newest first). */
export function filesWithPrefix(dir, prefix) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.wav'))
    .map((name) => path.join(dir, name))
    .filter((file) => {
      try {
        return statSync(file).size > 0;
      } catch {
        return false;
      }
    })
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

/** Prints a compact table of recording metrics. */
export function printRecordings(entries) {
  for (const [label, file] of Object.entries(entries)) {
    if (!file) {
      process.stdout.write(`    ${label.padEnd(10)} (missing)\n`);
      continue;
    }
    process.stdout.write(`    ${label.padEnd(10)} ${path.basename(file)}\n`);
  }
}
