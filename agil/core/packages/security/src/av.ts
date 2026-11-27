/**
 * Pluggable antivirus scanning for uploaded files.
 *
 * Two engines ship here, both driven as external processes/sockets:
 *   - {@link ClamAvScanner}  — clamd `INSTREAM` protocol over TCP or a unix socket;
 *   - {@link YaraScanner}    — optional `yara` CLI over a temporary file.
 *
 * A scanner never throws for scanner-side failures: it returns
 * `status:'error'`, and the caller decides (fail-open/fail-closed) through
 * {@link UploadScanService}. Engines are disabled unless explicitly configured.
 */
import { createHash, randomBytes } from 'node:crypto';
import { unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { connect, type Socket } from 'node:net';

/** 68-byte EICAR antivirus test string, assembled at runtime (harmless test artifact). */
export const EICAR_TEST_STRING = [
  'X5O!P%@AP[4\\PZX54(P^)7CC)7}$',
  'EICAR-STAN',
  'DARD-ANTIVIRUS-TEST-FILE!$H+H*',
].join('');

/** Bytes in one megabyte (binary). */
const MB = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 120_000;
/** clamd INSTREAM frames carry at most this many payload bytes. */
const INSTREAM_CHUNK = 64 * 1024;
const MAX_DETAIL_LENGTH = 300;

export type AvScanStatus = 'clean' | 'infected' | 'error' | 'skipped';

/** One file to scan. Only metadata + bytes: tenant scoping is the caller's job. */
export interface AvScanInput {
  data: Buffer;
  tenantId: string;
  roomId?: string;
  /** Store id (FileStore/RecordingStore) for audit correlation. */
  fileId?: string;
  fileName?: string;
  mime?: string;
}

/** Result of one scan attempt; `status:'error'` means "not scanned", not "clean". */
export interface AvScanResult {
  status: AvScanStatus;
  engine: string;
  /** Matched signature name, e.g. `Eicar-Test-Signature` or a YARA rule id. */
  signature?: string;
  /** Human-readable reason for `error`/`skipped` (never contains file content). */
  detail?: string;
  durationMs: number;
  scannedAt: number;
  bytes: number;
}

export interface AvScanOptions {
  /** Per-scan timeout override (clamped to 100 ms .. 120 s). */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** A pluggable malware scanner. `isConfigured()` gates the whole feature. */
export interface AvScanner {
  readonly name: string;
  /** True when the engine can actually be reached (daemon/CLI configured). */
  isConfigured(): boolean;
  /** Scans the buffer; never throws for scanner-side failures. */
  scan(input: AvScanInput, options?: AvScanOptions): Promise<AvScanResult>;
}

export interface ClamAvScannerOptions {
  /** clamd TCP host (default `127.0.0.1`; empty = not configured). */
  host?: string;
  /** clamd TCP port (default 3310). */
  port?: number;
  /** Unix socket path (`/var/run/clamav/clamd.ctl`); wins over host/port. */
  socketPath?: string;
  /** Default timeout in milliseconds (default 10000). */
  timeoutMs?: number;
  /** Files above this size are `skipped` (default 64 MiB; per-tenant caps apply). */
  maxBytes?: number;
  /** Test seam; defaults to `net.connect`. */
  connectImpl?: (options: { host?: string; port?: number; path?: string }) => Socket;
}

function clampTimeout(value: number | undefined, fallback: number): number {
  const candidate = Number.isFinite(value) && (value as number) > 0 ? Math.floor(value as number) : fallback;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, candidate));
}

function errorResult(engine: string, startedAt: number, bytes: number, detail: unknown): AvScanResult {
  const message = (detail instanceof Error ? detail.message : String(detail)).slice(0, MAX_DETAIL_LENGTH);
  return {
    status: 'error',
    engine,
    detail: message,
    durationMs: Date.now() - startedAt,
    scannedAt: Date.now(),
    bytes,
  };
}

/** Frames a buffer as clamd INSTREAM: command, length-prefixed chunks, zero terminator. */
export function frameClamAvInstream(data: Buffer): Buffer {
  const chunkCount = Math.max(1, Math.ceil(data.length / INSTREAM_CHUNK));
  const total = 'zINSTREAM\0'.length + data.length + chunkCount * 4 + 4;
  const frame = Buffer.allocUnsafe(total);
  let offset = frame.write('zINSTREAM\0', 0, 'ascii');
  for (let index = 0; index < data.length; index += INSTREAM_CHUNK) {
    const chunk = data.subarray(index, Math.min(index + INSTREAM_CHUNK, data.length));
    frame.writeUInt32BE(chunk.length, offset);
    offset += 4;
    chunk.copy(frame, offset);
    offset += chunk.length;
  }
  frame.writeUInt32BE(0, offset);
  return frame;
}

export interface ParsedClamAvResponse {
  status: 'clean' | 'infected' | 'error';
  signature?: string;
  detail?: string;
}

/** Parses one clamd reply such as `stream: Eicar-Test-Signature FOUND`. */
export function parseClamAvResponse(raw: string): ParsedClamAvResponse {
  const text = raw.replace(/\0/g, '').trim();
  if (!text) return { status: 'error', detail: 'empty clamd response' };
  const match = /^(.*?):\s*(.*)$/.exec(text);
  const body = (match?.[2] ?? text).trim();
  if (/\bOK$/i.test(body)) return { status: 'clean' };
  if (/\bFOUND$/i.test(body)) {
    const signature = body.replace(/\s+FOUND$/i, '').trim();
    return { status: 'infected', ...(signature ? { signature: signature.slice(0, 200) } : {}) };
  }
  return { status: 'error', detail: text.slice(0, MAX_DETAIL_LENGTH) };
}

/** ClamAV/clamd scanner using the zero-dependency INSTREAM protocol. */
export class ClamAvScanner implements AvScanner {
  readonly name = 'clamav';
  private readonly host: string;
  private readonly port: number;
  private readonly socketPath: string;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly connectImpl: (options: { host?: string; port?: number; path?: string }) => Socket;

  constructor(options: ClamAvScannerOptions = {}) {
    const source = options && typeof options === 'object' ? options : {};
    this.host = typeof source.host === 'string' ? source.host.trim() : '';
    this.port = Number.isFinite(source.port) ? Math.floor(source.port as number) : 3310;
    this.socketPath = typeof source.socketPath === 'string' ? source.socketPath.trim() : '';
    this.timeoutMs = clampTimeout(source.timeoutMs, DEFAULT_TIMEOUT_MS);
    this.maxBytes =
      Number.isFinite(source.maxBytes) && (source.maxBytes as number) > 0 ? (source.maxBytes as number) : 64 * MB;
    this.connectImpl = source.connectImpl ?? ((options) => connect(options as { host: string; port: number }));
  }

  isConfigured(): boolean {
    return this.socketPath.length > 0 || (this.host.length > 0 && this.port > 0);
  }

  async scan(input: AvScanInput, options: AvScanOptions = {}): Promise<AvScanResult> {
    const startedAt = Date.now();
    const bytes = Buffer.isBuffer(input?.data) ? input.data.length : 0;
    if (!Buffer.isBuffer(input?.data)) return errorResult(this.name, startedAt, 0, 'data must be a Buffer');
    if (!this.isConfigured()) return errorResult(this.name, startedAt, bytes, 'clamd is not configured');
    if (bytes > this.maxBytes) {
      return {
        status: 'skipped',
        engine: this.name,
        detail: `file is ${bytes} bytes; the scanner limit is ${this.maxBytes} bytes`,
        durationMs: Date.now() - startedAt,
        scannedAt: Date.now(),
        bytes,
      };
    }
    const timeoutMs = clampTimeout(options.timeoutMs, this.timeoutMs);
    try {
      const reply = await this.streamToClamd(input.data, timeoutMs, options.signal);
      const parsed = parseClamAvResponse(reply);
      if (parsed.status === 'clean') {
        return { status: 'clean', engine: this.name, durationMs: Date.now() - startedAt, scannedAt: Date.now(), bytes };
      }
      if (parsed.status === 'infected') {
        return {
          status: 'infected',
          engine: this.name,
          ...(parsed.signature ? { signature: parsed.signature } : {}),
          durationMs: Date.now() - startedAt,
          scannedAt: Date.now(),
          bytes,
        };
      }
      return {
        status: 'error',
        engine: this.name,
        ...(parsed.detail ? { detail: parsed.detail } : {}),
        durationMs: Date.now() - startedAt,
        scannedAt: Date.now(),
        bytes,
      };
    } catch (error) {
      return errorResult(this.name, startedAt, bytes, error);
    }
  }

  private streamToClamd(data: Buffer, timeoutMs: number, signal?: AbortSignal): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const socket = this.connectImpl(
        this.socketPath ? { path: this.socketPath } : { host: this.host, port: this.port },
      );
      let settled = false;
      let response = '';
      const timer = setTimeout(() => finish(new Error(`clamd timeout after ${timeoutMs} ms`)), timeoutMs);
      timer.unref?.();
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        socket.destroy();
        if (error) reject(error);
        else resolve(response);
      };
      const onAbort = (): void => finish(new Error('scan aborted'));
      if (signal?.aborted) {
        finish(new Error('scan aborted'));
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      socket.on('connect', () => {
        try {
          // Do not half-close after writing: clamd replies on the INSTREAM
          // terminator, and a FIN would let the socket end before the verdict.
          socket.write(frameClamAvInstream(data));
        } catch (error) {
          finish(error instanceof Error ? error : new Error('clamd write failed'));
        }
      });
      socket.on('data', (chunk: Buffer) => {
        response += chunk.toString('utf8');
        if (response.includes('\0')) finish();
      });
      socket.on('end', () => finish());
      socket.on('error', (error) => finish(error instanceof Error ? error : new Error('clamd socket error')));
      socket.on('timeout', () => finish(new Error(`clamd timeout after ${timeoutMs} ms`)));
    });
  }
}

export interface YaraScannerOptions {
  /** Path to a `.yar`/`.yara` rule file (required; empty = not configured). */
  rulesPath?: string;
  /** CLI binary (default `yara`). */
  command?: string;
  /** Extra arguments before `<rules> <target>` (default `['-w']` to silence warnings). */
  argsPrefix?: string[];
  timeoutMs?: number;
  maxBytes?: number;
  /** Test seam; defaults to `child_process.execFile`. */
  execFileImpl?: typeof execFile;
}

/**
 * Optional YARA CLI scanner. Writes the upload to a temporary
 * file, runs `yara <rules> <tmpfile>` and maps the first match to `infected`.
 * Exit code 1 means "rules matched"; 2+ / timeout are scanner errors.
 */
export class YaraScanner implements AvScanner {
  readonly name = 'yara';
  private readonly rulesPath: string;
  private readonly command: string;
  private readonly argsPrefix: string[];
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly execFileImpl: typeof execFile;

  constructor(options: YaraScannerOptions = {}) {
    const source = options && typeof options === 'object' ? options : {};
    this.rulesPath = typeof source.rulesPath === 'string' ? source.rulesPath.trim() : '';
    this.command = typeof source.command === 'string' && source.command.trim() ? source.command.trim() : 'yara';
    this.argsPrefix = Array.isArray(source.argsPrefix) ? source.argsPrefix.filter((arg) => typeof arg === 'string') : ['-w'];
    this.timeoutMs = clampTimeout(source.timeoutMs, DEFAULT_TIMEOUT_MS);
    this.maxBytes =
      Number.isFinite(source.maxBytes) && (source.maxBytes as number) > 0 ? (source.maxBytes as number) : 25 * MB;
    this.execFileImpl = source.execFileImpl ?? execFile;
  }

  isConfigured(): boolean {
    return this.rulesPath.length > 0;
  }

  async scan(input: AvScanInput, options: AvScanOptions = {}): Promise<AvScanResult> {
    const startedAt = Date.now();
    const bytes = Buffer.isBuffer(input?.data) ? input.data.length : 0;
    if (!Buffer.isBuffer(input?.data)) return errorResult(this.name, startedAt, 0, 'data must be a Buffer');
    if (!this.isConfigured()) return errorResult(this.name, startedAt, bytes, 'AGIL_YARA_RULES is not configured');
    if (bytes > this.maxBytes) {
      return {
        status: 'skipped',
        engine: this.name,
        detail: `file is ${bytes} bytes; the scanner limit is ${this.maxBytes} bytes`,
        durationMs: Date.now() - startedAt,
        scannedAt: Date.now(),
        bytes,
      };
    }
    const timeoutMs = clampTimeout(options.timeoutMs, this.timeoutMs);
    const tempPath = join(tmpdir(), `agil-yara-${randomBytes(8).toString('hex')}`);
    try {
      writeFileSync(tempPath, input.data, { mode: 0o600 });
      const { stdout } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        this.execFileImpl(
          this.command,
          [...this.argsPrefix, this.rulesPath, tempPath],
          { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024, signal: options.signal },
          (error, stdout, stderr) => {
            const failure = error as (Error & { code?: number | string; killed?: boolean }) | null;
            // `yara` exits 1 when rules matched — that is a successful scan.
            if (failure && failure.code !== 1) {
              const reason = failure.killed ? `yara timeout after ${timeoutMs} ms` : failure.message;
              reject(new Error(reason));
              return;
            }
            resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
          },
        );
      });
      const firstMatch = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0);
      if (firstMatch) {
        return {
          status: 'infected',
          engine: this.name,
          signature: (firstMatch.split(/\s+/)[0] ?? 'yara_match').slice(0, 200),
          durationMs: Date.now() - startedAt,
          scannedAt: Date.now(),
          bytes,
        };
      }
      return { status: 'clean', engine: this.name, durationMs: Date.now() - startedAt, scannedAt: Date.now(), bytes };
    } catch (error) {
      return errorResult(this.name, startedAt, bytes, error);
    } finally {
      try {
        unlinkSync(tempPath);
      } catch {
        /* temp file already gone */
      }
    }
  }
}

/**
 * Runs several scanners in order: an infection from any engine wins, otherwise
 * an error from any engine is reported (so fail-closed policies still trigger).
 */
export class CompositeAvScanner implements AvScanner {
  readonly name = 'composite';
  private readonly scanners: AvScanner[];

  constructor(scanners: AvScanner[]) {
    this.scanners = Array.isArray(scanners) ? scanners.filter((scanner) => scanner && typeof scanner.scan === 'function') : [];
  }

  /** Configured when at least one child engine is configured. */
  isConfigured(): boolean {
    return this.scanners.some((scanner) => scanner.isConfigured());
  }

  get engines(): readonly string[] {
    return this.scanners.map((scanner) => scanner.name);
  }

  async scan(input: AvScanInput, options: AvScanOptions = {}): Promise<AvScanResult> {
    const startedAt = Date.now();
    const details: string[] = [];
    let cleanSeen = false;
    for (const scanner of this.scanners) {
      if (!scanner.isConfigured()) continue;
      const result = await scanner.scan(input, options);
      if (result.status === 'infected') return result;
      if (result.status === 'clean' || result.status === 'skipped') cleanSeen = true;
      if (result.status === 'error') details.push(`${scanner.name}: ${result.detail ?? 'error'}`);
    }
    if (details.length > 0) {
      return {
        status: 'error',
        engine: this.name,
        detail: details.join('; ').slice(0, MAX_DETAIL_LENGTH),
        durationMs: Date.now() - startedAt,
        scannedAt: Date.now(),
        bytes: Buffer.isBuffer(input?.data) ? input.data.length : 0,
      };
    }
    if (!cleanSeen) {
      return {
        status: 'error',
        engine: this.name,
        detail: 'no configured scanner engine',
        durationMs: Date.now() - startedAt,
        scannedAt: Date.now(),
        bytes: Buffer.isBuffer(input?.data) ? input.data.length : 0,
      };
    }
    return {
      status: 'clean',
      engine: this.name,
      durationMs: Date.now() - startedAt,
      scannedAt: Date.now(),
      bytes: Buffer.isBuffer(input?.data) ? input.data.length : 0,
    };
  }
}

/** Stable SHA-256 of a payload (quarantine metadata / correlation). */
export function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}
