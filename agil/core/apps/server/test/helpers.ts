/**
 * Shared test harness: starts a real server on an ephemeral port with a
 * throwaway data directory and gives tests small HTTP/WS helpers.
 *
 * Every test file calls `startTestServer()` in `before()` and `close()` in
 * `after()`; nothing is left on disk or in the process table.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import { WebSocket } from 'ws';
import { createAgilServer, type AgilServer, type CreateServerOptions } from '../src/index.js';
import { silentLogger } from '../src/logger.js';

export interface TestServer {
  server: AgilServer;
  base: string;
  wsUrl: string;
  dataDir: string;
  api(method: string, route: string, options?: ApiOptions): Promise<ApiResponse>;
  close(): Promise<void>;
}

export interface ApiOptions {
  body?: unknown;
  headers?: Record<string, string>;
  rawBody?: string | Buffer;
  contentType?: string;
  /**
   * Override the `Host` header. `fetch` treats Host as a forbidden header, so
   * these requests go through `node:http` instead (custom-domain tests).
   */
  host?: string;
}

export interface ApiResponse {
  status: number;
  body: any;
  headers: Headers;
  text: string;
}

/** `fetch` cannot set `Host`; this variant uses `node:http` and keeps the shape. */
function apiWithHost(base: string, method: string, route: string, options: ApiOptions): Promise<ApiResponse> {
  return new Promise((resolve, reject) => {
    const target = new URL(`${base}${route}`);
    const headers: Record<string, string> = { ...(options.headers ?? {}), host: options.host as string };
    let body: string | Buffer | undefined = options.rawBody;
    if (body === undefined && options.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(options.body);
    }
    if (options.contentType) headers['content-type'] = options.contentType;
    if (typeof body === 'string' || body instanceof Buffer) headers['content-length'] = String(Buffer.byteLength(body));
    const request = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method,
        headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: any = null;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            parsed = text;
          }
          const responseHeaders = new Headers();
          for (let index = 0; index < response.rawHeaders.length; index += 2) {
            responseHeaders.append(response.rawHeaders[index] as string, response.rawHeaders[index + 1] as string);
          }
          resolve({ status: response.statusCode ?? 0, body: parsed, headers: responseHeaders, text });
        });
      },
    );
    request.on('error', reject);
    request.end(body);
  });
}

export async function startTestServer(overrides: CreateServerOptions = {}): Promise<TestServer> {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'agil-server-test-'));
  const server = await createAgilServer({
    port: 0,
    host: '127.0.0.1',
    dataDir,
    tokenSecret: 'test-secret-0123456789',
    apiKeys: { 'dev-key': 'demo', 'acme-key': 'acme' },
    allowAnonymous: true,
    publicOrigin: 'http://127.0.0.1:1',
    logger: silentLogger,
    ...overrides,
  });
  const boundHost = overrides.host;
  const address = !boundHost || boundHost === '0.0.0.0' || boundHost === '::' ? '127.0.0.1' : boundHost;
  const urlHost = address.includes(':') ? `[${address}]` : address;
  const base = `http://${urlHost}:${server.port}`;
  const testServer: TestServer = {
    server,
    base,
    wsUrl: `ws://${urlHost}:${server.port}/ws`,
    dataDir,
    api: async (method, route, options = {}) => {
      if (options.host) return apiWithHost(base, method, route, options);
      const headers: Record<string, string> = { ...(options.headers ?? {}) };
      let body: string | Buffer | undefined = options.rawBody;
      if (body === undefined && options.body !== undefined) {
        headers['content-type'] = 'application/json';
        body = JSON.stringify(options.body);
      }
      if (options.contentType) headers['content-type'] = options.contentType;
      const response = await fetch(`${base}${route}`, { method, headers, body, redirect: 'manual' });
      const text = await response.text();
      let parsed: any = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text;
      }
      return { status: response.status, body: parsed, headers: response.headers, text };
    },
    close: async () => {
      await server.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
  return testServer;
}

/** Resolves a stored artifact URL path against the test server base. */
export function relativeUrl(recordUrl: string): string {
  const url = new URL(recordUrl);
  return `${url.pathname}${url.search}`;
}

export interface WsClient {
  socket: WebSocket;
  messages: Array<Record<string, any>>;
  waitFor(predicate: (message: Record<string, any>) => boolean, timeoutMs?: number): Promise<Record<string, any>>;
  send(message: unknown): void;
  close(): Promise<void>;
}

export interface OpenWsOptions {
  /**
   * Browser-style `Origin` header. Omit to emulate a non-browser SDK (no
   * Origin); pass `'null'` for an opaque/sandboxed origin. The server enforces
   * its allowlist only when an Origin is present (or for anonymous joins).
   */
  origin?: string;
}

export function openWs(url: string, protocols?: string[], options: OpenWsOptions = {}): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const wsOptions: WebSocket.ClientOptions = {
      maxPayload: 1024 * 1024,
      ...(options.origin !== undefined ? { origin: options.origin } : {}),
    };
    const socket = protocols && protocols.length > 0
      ? new WebSocket(url, protocols, wsOptions)
      : new WebSocket(url, wsOptions);
    const messages: Array<Record<string, any>> = [];
    const waiters: Array<{
      predicate: (message: Record<string, any>) => boolean;
      resolve: (message: Record<string, any>) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }> = [];
    const settle = (): void => {
      for (const waiter of [...waiters]) {
        const found = messages.find((message) => waiter.predicate(message));
        if (!found) continue;
        clearTimeout(waiter.timer);
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(found);
      }
    };
    const timer = setTimeout(() => reject(new Error('ws open timeout')), 5000);
    socket.on('open', () => {
      clearTimeout(timer);
      resolve({
        socket,
        messages,
        waitFor(predicate, timeoutMs = 5000) {
          const existing = messages.find((message) => predicate(message));
          if (existing) return Promise.resolve(existing);
          return new Promise((resolveWaiter, rejectWaiter) => {
            const waiterTimer = setTimeout(() => {
              const index = waiters.findIndex((waiter) => waiter.timer === waiterTimer);
              if (index >= 0) waiters.splice(index, 1);
              rejectWaiter(new Error(`ws message timeout; got: ${messages.map((message) => message.type).join(',')}`));
            }, timeoutMs);
            waiterTimer.unref?.();
            waiters.push({ predicate, resolve: resolveWaiter, reject: rejectWaiter, timer: waiterTimer });
          });
        },
        send(message) {
          socket.send(typeof message === 'string' ? message : JSON.stringify(message));
        },
        async close() {
          if (socket.readyState === WebSocket.CLOSED) return;
          await new Promise<void>((resolveClose) => {
            socket.once('close', () => resolveClose());
            socket.close();
            setTimeout(() => resolveClose(), 1000).unref?.();
          });
        },
      });
    });
    socket.on('message', (data) => {
      try {
        messages.push(JSON.parse(String(data)) as Record<string, any>);
      } catch {
        messages.push({ type: 'raw', data: String(data) });
      }
      settle();
    });
    socket.on('close', () => {
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('ws closed before the expected message'));
      }
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** Waits for a socket close; resolves with the close code. */
export function waitForClose(client: WsClient, timeoutMs = 5000): Promise<number> {
  return new Promise((resolve, reject) => {
    if (client.socket.readyState === WebSocket.CLOSED) {
      resolve(1000);
      return;
    }
    const timer = setTimeout(() => reject(new Error('ws close timeout')), timeoutMs);
    timer.unref?.();
    client.socket.once('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

export async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
