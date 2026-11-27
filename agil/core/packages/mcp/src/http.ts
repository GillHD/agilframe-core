#!/usr/bin/env node
/**
 * AgilFrame MCP server — streamable HTTP entry point (docs/api-exposure.md).
 *
 * Run it explicitly:
 *   AGIL_MCP_HTTP_ENABLED=1 AGIL_MCP_HTTP_TOKEN=... node agil/core/packages/mcp/dist/http.js
 * or let the stdio entry switch transports:
 *   AGIL_MCP_HTTP_ENABLED=1 AGIL_MCP_HTTP_TOKEN=... node agil/core/packages/mcp/dist/index.js
 *
 * Endpoint: POST /mcp (stateless streamable HTTP, JSON responses).
 * Security: Bearer token (constant-time compare), IP allowlist on the real
 * connection IP, body limit, `cache-control: no-store`. Tokens are never logged.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { readEnv, type McpEnv } from './env.js';
import { AgilHttpClient } from './http-client.js';
import { createMcpServer, log, SERVER_NAME, SERVER_VERSION } from './server.js';

export const DEFAULT_HTTP_PORT = 8791;
export const DEFAULT_HTTP_HOST = '127.0.0.1';
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
export const MCP_HTTP_PATH = '/mcp';

export interface HttpMcpConfig {
  host: string;
  port: number;
  token: string;
  allowIps: string[];
  maxBodyBytes: number;
  /** Trust the first `x-forwarded-for` hop (only behind a trusted proxy). */
  trustProxy: boolean;
}

export interface ReadHttpConfigResult {
  config: HttpMcpConfig;
  warnings: string[];
}

function parseIntEnv(raw: string | undefined, fallback: number): number | undefined {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Reads AGIL_MCP_HTTP_* / AGIL_TRUST_PROXY. Never throws: bad values fall back
 * to safe defaults with a warning.
 */
export function readHttpConfig(source: NodeJS.ProcessEnv = process.env): ReadHttpConfigResult {
  const warnings: string[] = [];
  let port = parseIntEnv(source.AGIL_MCP_HTTP_PORT, DEFAULT_HTTP_PORT);
  if (port === undefined || port < 0 || port > 65_535) {
    warnings.push(`AGIL_MCP_HTTP_PORT="${source.AGIL_MCP_HTTP_PORT}" is invalid; using ${DEFAULT_HTTP_PORT}.`);
    port = DEFAULT_HTTP_PORT;
  }
  const host = (source.AGIL_MCP_HTTP_HOST ?? '').trim() || DEFAULT_HTTP_HOST;
  const token = (source.AGIL_MCP_HTTP_TOKEN ?? '').trim();
  if (!token) {
    warnings.push(
      'AGIL_MCP_HTTP_TOKEN is not set: the HTTP MCP endpoint will reject every request with 401 until a token is configured.',
    );
  }
  const allowIps = (source.AGIL_MCP_HTTP_ALLOW_IPS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (allowIps.length === 0) {
    warnings.push('AGIL_MCP_HTTP_ALLOW_IPS is empty: every IP that knows the token may connect (use an allowlist in production).');
  }
  let maxBodyBytes = parseIntEnv(source.AGIL_MCP_HTTP_MAX_BODY_BYTES, DEFAULT_MAX_BODY_BYTES);
  if (maxBodyBytes === undefined || maxBodyBytes < 1024 || maxBodyBytes > 16 * 1024 * 1024) {
    warnings.push(
      `AGIL_MCP_HTTP_MAX_BODY_BYTES="${source.AGIL_MCP_HTTP_MAX_BODY_BYTES}" is invalid; using ${DEFAULT_MAX_BODY_BYTES}.`,
    );
    maxBodyBytes = DEFAULT_MAX_BODY_BYTES;
  }
  const trustProxy = (source.AGIL_TRUST_PROXY ?? '').trim() === '1';
  return {
    config: { host, port, token, allowIps, maxBodyBytes, trustProxy },
    warnings,
  };
}

/* ------------------------------------------------------------------ */
/* Security helpers                                                    */
/* ------------------------------------------------------------------ */

/** Strips IPv4-mapped IPv6 (`::ffff:127.0.0.1`) and zone ids. */
export function normalizeIp(ip: string): string {
  let value = ip.trim();
  if (value.toLowerCase().startsWith('::ffff:')) value = value.slice(7);
  const zone = value.indexOf('%');
  if (zone >= 0) value = value.slice(0, zone);
  return value;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const byte = Number(part);
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) return null;
    value = (value << 8) | byte;
  }
  return value >>> 0;
}

/** IPv4 CIDR match (IPv6 entries are matched exactly only). */
function matchesCidr(ip: string, cidr: string): boolean {
  const [base, bitsRaw] = cidr.split('/');
  if (!base || bitsRaw === undefined) return false;
  const bits = Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const baseInt = ipv4ToInt(base);
  const ipInt = ipv4ToInt(ip);
  if (baseInt === null || ipInt === null) return false;
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

/** Allowlist check: exact IPs (IPv4/IPv6) and IPv4 CIDR ranges. */
export function isIpAllowed(ip: string, allowIps: readonly string[]): boolean {
  if (allowIps.length === 0) return true;
  const normalized = normalizeIp(ip);
  return allowIps.some((entry) => {
    const candidate = normalizeIp(entry);
    if (candidate === normalized) return true;
    return candidate.includes('/') ? matchesCidr(normalized, candidate) : false;
  });
}

/** Real connection IP; `x-forwarded-for` only when a trusted proxy is configured. */
export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const header = req.headers['x-forwarded-for'];
    const raw = Array.isArray(header) ? header[0] : header;
    const first = raw?.split(',')[0]?.trim();
    if (first) return normalizeIp(first);
  }
  return normalizeIp(req.socket.remoteAddress ?? '');
}

/** Constant-time bearer check (SHA-256 digests, so length leaks nothing). */
export function tokenMatches(expected: string, authorization: string | undefined): boolean {
  if (!expected) return false;
  const match = /^Bearer\s+(.+)$/i.exec((authorization ?? '').trim());
  if (!match?.[1]) return false;
  const provided = match[1].trim();
  const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(digest(expected), digest(provided));
}

/* ------------------------------------------------------------------ */
/* HTTP plumbing                                                       */
/* ------------------------------------------------------------------ */

class BodyTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`Request body exceeds ${limit} bytes`);
    this.name = 'BodyTooLargeError';
  }
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) reject(new BodyTooLargeError(limit));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

function sendJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  });
  res.end(body);
}

export interface HttpServerOptions {
  config: HttpMcpConfig;
  env: McpEnv;
  client?: AgilHttpClient;
}

/** Handles one HTTP request to /mcp. Exported for tests. */
export async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: HttpServerOptions,
): Promise<void> {
  const { config, env } = options;
  // Never let proxies/clients cache MCP responses (they may contain tenant data).
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (url.pathname !== MCP_HTTP_PATH) {
    sendJson(res, 404, { error: { code: 'not_found', message: 'Use POST /mcp' } });
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: { code: 'method_not_allowed', message: 'Only POST /mcp is supported' } }, {
      allow: 'POST',
    });
    return;
  }

  const ip = clientIp(req, config.trustProxy);
  if (!isIpAllowed(ip, config.allowIps)) {
    log(`http rejected: ip=${ip} is not in AGIL_MCP_HTTP_ALLOW_IPS`);
    sendJson(res, 403, { error: { code: 'forbidden', message: 'IP is not allowed' } });
    return;
  }

  const authorization = req.headers.authorization;
  if (!tokenMatches(config.token, typeof authorization === 'string' ? authorization : undefined)) {
    log(`http rejected: unauthorized request from ip=${ip} (token ${config.token ? 'mismatch' : 'not configured'})`);
    sendJson(
      res,
      401,
      { error: { code: 'unauthorized', message: 'Provide Authorization: Bearer <AGIL_MCP_HTTP_TOKEN>' } },
      { 'www-authenticate': 'Bearer' },
    );
    return;
  }

  const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    sendJson(res, 415, {
      error: { code: 'unsupported_media_type', message: 'Content-Type must be application/json' },
    });
    return;
  }

  let parsedBody: unknown;
  try {
    const raw = await readBody(req, config.maxBodyBytes);
    if (!raw.trim()) {
      sendJson(res, 400, { error: { code: 'bad_request', message: 'Empty JSON-RPC body' } });
      return;
    }
    parsedBody = JSON.parse(raw);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      sendJson(res, 413, {
        error: { code: 'payload_too_large', message: `Body exceeds ${config.maxBodyBytes} bytes` },
      });
      return;
    }
    sendJson(res, 400, { error: { code: 'parse_error', message: 'Body must be valid JSON' } });
    return;
  }

  const client = options.client ?? new AgilHttpClient(env);
  const { server } = createMcpServer({ client, env });
  // Stateless: a fresh transport per request (the SDK forbids reuse).
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  } catch (error) {
    log(`http request failed: ${error instanceof Error ? error.message : String(error)}`);
    sendJson(res, 500, { error: { code: 'internal_error', message: 'MCP request failed' } });
  } finally {
    // Nothing to keep alive in stateless mode.
    res.once('close', () => {
      void server.close().catch(() => undefined);
    });
  }
}

export interface RunningHttpServer {
  host: string;
  port: number;
  close: () => Promise<void>;
}

/** Starts the streamable HTTP MCP server. */
export async function startHttpServer(options: HttpServerOptions): Promise<RunningHttpServer> {
  const { config, env } = options;
  const client = options.client ?? new AgilHttpClient(env);
  const httpServer = createServer((req, res) => {
    void handleMcpRequest(req, res, { config, env, client }).catch((error: unknown) => {
      log(`http handler error: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) {
        sendJson(res, 500, { error: { code: 'internal_error', message: 'MCP request failed' } });
      } else {
        res.end();
      }
    });
  });
  httpServer.setTimeout(120_000);

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(config.port, config.host, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });
  const address = httpServer.address();
  const port = typeof address === 'object' && address !== null ? address.port : config.port;

  log(
    `${SERVER_NAME}@${SERVER_VERSION} HTTP MCP listening on http://${config.host}:${port}${MCP_HTTP_PATH} ` +
      `mode=${env.mode} token=${config.token ? 'configured' : 'NOT SET'} ` +
      `allowIps=${config.allowIps.length > 0 ? config.allowIps.join(',') : '*'}`,
  );

  return {
    host: config.host,
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

/** Reads env and starts the HTTP server (used by dist/http.js and index.ts). */
export async function startHttpFromEnv(
  options: { env?: McpEnv; client?: AgilHttpClient } = {},
): Promise<{ running: RunningHttpServer; config: HttpMcpConfig }> {
  const envResult = readEnv();
  for (const warning of envResult.warnings) log(`warning: ${warning}`);
  const env = options.env ?? envResult.env;
  const httpResult = readHttpConfig();
  for (const warning of httpResult.warnings) log(`warning: ${warning}`);
  const client = options.client ?? new AgilHttpClient(env);
  const running = await startHttpServer({ config: httpResult.config, env, client });
  return { running, config: httpResult.config };
}

const isDirectEntry = (() => {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    return resolve(entry).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
  } catch {
    return false;
  }
})();

if (isDirectEntry) {
  startHttpFromEnv()
    .then(({ running }) => {
      const shutdown = (signal: string): void => {
        log(`received ${signal}, shutting down HTTP MCP`);
        void running.close().finally(() => process.exit(0));
      };
      process.once('SIGINT', () => shutdown('SIGINT'));
      process.once('SIGTERM', () => shutdown('SIGTERM'));
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
      console.error(`[agil-mcp] fatal: ${message}`);
      process.exit(1);
    });
}
