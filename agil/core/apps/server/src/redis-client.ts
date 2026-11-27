/**
 * Minimal RESP2 Redis client for the Core leader lease (docs/ha-leader.md).
 *
 * Minimal RESP2 client for the five commands the lease needs (`SET NX PX`,
 * `EVAL`, `PTTL`, `HGETALL`, `HSET`), with an explicit connection state so the
 * lease can stop renewing deterministically. Not a general-purpose Redis driver.
 *
 * Supported URLs: `redis://[user:password@]host:port[/db]` and
 * `rediss://…` (TLS). AUTH/SELECT are sent on connect when present in the URL.
 */
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';

export type RespValue = string | number | null | RespValue[];

/** A Redis error reply (`-ERR …`). */
export class RedisReplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RedisReplyError';
  }
}

export interface ParsedRedisUrl {
  host: string;
  port: number;
  tls: boolean;
  username: string;
  password: string;
  db: number;
}

/** Parses and validates a `redis(s)://` URL; throws on malformed input. */
export function parseRedisUrl(raw: string): ParsedRedisUrl {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('AGIL_REDIS_URL is not a valid URL');
  }
  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
    throw new Error('AGIL_REDIS_URL must start with redis:// or rediss://');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw new Error('AGIL_REDIS_URL has no host');
  const port = url.port ? Number(url.port) : 6379;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('AGIL_REDIS_URL has an invalid port');
  const db = url.pathname && url.pathname !== '/' ? Number(url.pathname.slice(1)) : 0;
  if (!Number.isInteger(db) || db < 0 || db > 15) throw new Error('AGIL_REDIS_URL has an invalid database index');
  return {
    host,
    port,
    tls: url.protocol === 'rediss:',
    username: url.username ? decodeURIComponent(url.username) : '',
    password: url.password ? decodeURIComponent(url.password) : '',
    db,
  };
}

interface PendingCommand {
  resolve: (value: RespValue) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

type ParseOutcome = { value: RespValue } | { error: Error };

export interface RedisClientOptions {
  url: string;
  /** Connect timeout (ms). Default 1500. */
  connectTimeoutMs?: number;
  /** Per-command timeout (ms). Default 2000. */
  commandTimeoutMs?: number;
  /** Called after a successful (re)connect, including AUTH/SELECT. */
  onConnect?: () => void;
  /** Called when an established connection is lost; reconnect is automatic. */
  onDisconnect?: (error: Error) => void;
  /** Called when a background reconnect attempt fails. */
  onConnectError?: (error: Error) => void;
}

/**
 * A small pipelined RESP2 client. Commands issued while disconnected fail fast
 * (the caller — the lease — must observe the loss and use its fencing deadline);
 * `connect()` may be called again to reconnect.
 */
export class RedisClient {
  private readonly parsed: ParsedRedisUrl;
  private readonly connectTimeoutMs: number;
  private readonly commandTimeoutMs: number;
  private readonly options: RedisClientOptions;
  private socket: Socket | TLSSocket | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private pending: PendingCommand[] = [];
  private ready = false;
  private closed = false;
  private connectPromise: Promise<void> | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelay = 500;

  constructor(options: RedisClientOptions) {
    this.options = options;
    this.parsed = parseRedisUrl(options.url);
    this.connectTimeoutMs = options.connectTimeoutMs ?? 1500;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 2000;
  }

  get connected(): boolean {
    return this.ready && this.socket !== null;
  }

  /** Connects (idempotent). Rejects when the connection or AUTH/SELECT fails. */
  async connect(): Promise<void> {
    if (this.closed) throw new Error('Redis client is closed');
    if (this.ready) return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.open().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  private open(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const { host, port, tls } = this.parsed;
      const socket = tls
        ? tlsConnect({ host, port, servername: host, rejectUnauthorized: true })
        : netConnect({ host, port });
      this.socket = socket;
      this.ready = false;
      this.buffer = Buffer.alloc(0);
      let settled = false;
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.ready = false;
        this.socket = null;
        socket.destroy();
        reject(error);
      };
      const timer = setTimeout(() => fail(new Error(`Redis connect timeout after ${this.connectTimeoutMs} ms`)), this.connectTimeoutMs);
      timer.unref?.();

      socket.setNoDelay(true);
      socket.setKeepAlive(true, 5_000);
      socket.on('data', (chunk: Buffer) => this.onData(chunk));
      socket.on('error', (error: Error) => {
        if (!settled) {
          fail(error);
          return;
        }
        this.handleDisconnect(error);
      });
      socket.on('close', () => {
        if (!settled) {
          fail(new Error('Redis connection closed during handshake'));
          return;
        }
        this.handleDisconnect(new Error('Redis connection closed'));
      });
      const onReady = (): void => {
        void (async () => {
          try {
            this.ready = true;
            if (this.parsed.password) {
              const auth = this.parsed.username
                ? await this.command(['AUTH', this.parsed.username, this.parsed.password])
                : await this.command(['AUTH', this.parsed.password]);
              if (auth !== 'OK') throw new Error('Redis AUTH was rejected');
            }
            if (this.parsed.db > 0) {
              const selected = await this.command(['SELECT', String(this.parsed.db)]);
              if (selected !== 'OK') throw new Error(`Redis SELECT ${this.parsed.db} was rejected`);
            }
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            this.reconnectDelay = 500;
            this.options.onConnect?.();
            resolve();
          } catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)));
          }
        })();
      };
      if (tls) socket.once('secureConnect', onReady);
      else socket.once('connect', onReady);
    });
  }

  /** Sends one command; resolves with the RESP reply, rejects on error/timeout. */
  command(args: Array<string | number>): Promise<RespValue> {
    if (this.closed) return Promise.reject(new Error('Redis client is closed'));
    if (!this.ready || !this.socket) return Promise.reject(new Error('Redis is not connected'));
    return new Promise<RespValue>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.pending.findIndex((entry) => entry.timer === timer);
        if (index < 0) return;
        const [entry] = this.pending.splice(index, 1);
        // A timed-out reply can no longer be matched to its command; drop the
        // connection so every in-flight command fails instead of resolving with
        // another command's response. The lease treats this as a lost renewal.
        try {
          this.socket?.destroy();
        } catch {
          /* already gone */
        }
        this.handleDisconnect(new Error(`Redis command timed out after ${this.commandTimeoutMs} ms`));
        entry?.reject(new Error(`Redis command timed out after ${this.commandTimeoutMs} ms`));
      }, this.commandTimeoutMs);
      timer.unref?.();
      this.pending.push({ resolve, reject, timer });
      try {
        this.socket?.write(encodeCommand(args));
      } catch (error) {
        clearTimeout(timer);
        const index = this.pending.findIndex((entry) => entry.timer === timer);
        if (index >= 0) this.pending.splice(index, 1);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Stops the client, rejects pending commands and prevents reconnects. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const pending = this.pending.splice(0);
    for (const entry of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('Redis client closed'));
    }
    const socket = this.socket;
    this.socket = null;
    try {
      socket?.destroy();
    } catch {
      /* already gone */
    }
  }

  private onData(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const outcome = parseReply(this.buffer, 0);
      if (outcome === null) return;
      const consumed = outcome.next;
      this.buffer = this.buffer.subarray(consumed);
      const pending = this.pending.shift();
      if (!pending) continue;
      clearTimeout(pending.timer);
      if ('error' in outcome) pending.reject(outcome.error);
      else pending.resolve(outcome.value);
    }
  }

  private handleDisconnect(error: Error): void {
    if (this.closed) return;
    const wasReady = this.ready;
    this.ready = false;
    this.socket = null;
    const pending = this.pending.splice(0);
    for (const entry of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`Redis connection lost: ${error.message}`));
    }
    if (wasReady) this.options.onDisconnect?.(error);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(Math.round(this.reconnectDelay * 1.6), 5_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closed) return;
      this.connect().catch((error: unknown) => {
        this.options.onConnectError?.(error instanceof Error ? error : new Error(String(error)));
        this.scheduleReconnect();
      });
    }, delay);
    this.reconnectTimer.unref?.();
  }
}

/** Encodes a command as a RESP2 array of bulk strings. */
export function encodeCommand(args: ReadonlyArray<string | number>): Buffer {
  const parts: Buffer[] = [Buffer.from(`*${args.length}\r\n`, 'utf8')];
  for (const arg of args) {
    const value = Buffer.from(String(arg), 'utf8');
    parts.push(Buffer.from(`$${value.length}\r\n`, 'utf8'), value, Buffer.from('\r\n', 'utf8'));
  }
  return Buffer.concat(parts);
}

function readLine(buffer: Buffer, offset: number): { line: string; next: number } | null {
  const end = buffer.indexOf('\r\n', offset);
  if (end < 0) return null;
  return { line: buffer.subarray(offset, end).toString('utf8'), next: end + 2 };
}

function parseReply(buffer: Buffer, offset: number): (ParseOutcome & { next: number }) | null {
  if (offset >= buffer.length) return null;
  const type = String.fromCharCode(buffer[offset] as number);
  const afterType = offset + 1;
  if (type === '+' || type === '-' || type === ':') {
    const line = readLine(buffer, afterType);
    if (!line) return null;
    if (type === '-') return { error: new RedisReplyError(line.line), next: line.next };
    if (type === ':') return { value: Number(line.line), next: line.next };
    return { value: line.line, next: line.next };
  }
  if (type === '$') {
    const line = readLine(buffer, afterType);
    if (!line) return null;
    const length = Number(line.line);
    if (length === -1) return { value: null, next: line.next };
    if (!Number.isInteger(length) || length < 0) return { error: new Error(`Invalid RESP bulk length: ${line.line}`), next: line.next };
    const end = line.next + length;
    if (buffer.length < end + 2) return null;
    return { value: buffer.subarray(line.next, end).toString('utf8'), next: end + 2 };
  }
  if (type === '*') {
    const line = readLine(buffer, afterType);
    if (!line) return null;
    const count = Number(line.line);
    if (count === -1) return { value: null, next: line.next };
    if (!Number.isInteger(count) || count < 0) return { error: new Error(`Invalid RESP array length: ${line.line}`), next: line.next };
    const values: RespValue[] = [];
    let cursor = line.next;
    for (let index = 0; index < count; index += 1) {
      const nested = parseReply(buffer, cursor);
      if (!nested) return null;
      cursor = nested.next;
      if ('error' in nested) return { error: nested.error, next: cursor };
      values.push(nested.value);
    }
    return { value: values, next: cursor };
  }
  return { error: new Error(`Unsupported RESP type: ${type}`), next: buffer.length };
}
