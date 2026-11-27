/**
 * Shared plumbing for the optional on-box STT / translation engines.
 *
 * Everything here is lazy: importing this module never spawns a process, reads
 * a model or checks the filesystem. Engines call these helpers only when a
 * request or an explicit `availability()` probe arrives, so a deployment
 * without whisper.cpp / Python models still starts normally.
 *
 * No model binary or Python package is bundled: see
 * `scripts/local/download-models.mjs` and docs/stt-translation-local.md.
 */
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, copyFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { constants as fsConstants, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

/** Hard cap for captured stdout/stderr of a child process (bytes). */
const MAX_CAPTURED_OUTPUT = 256 * 1024;

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export class LocalProcessError extends Error {
  readonly code: 'not_found' | 'timeout' | 'failed' | 'invalid_output' | 'ffmpeg_missing';
  readonly detail?: string;

  constructor(code: LocalProcessError['code'], message: string, detail?: string) {
    super(message);
    this.name = 'LocalProcessError';
    this.code = code;
    this.detail = detail;
  }
}

/** True when `candidate` is an existing regular file. */
export async function fileExists(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}

export async function dirExists(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Local model snapshots (no network, no Python)                      */
/* ------------------------------------------------------------------ */

/**
 * Candidate HuggingFace hub cache roots, in lookup order. The list is purely
 * filesystem-based: asking "are the weights already here?" never contacts the
 * network. `cacheDirs` overrides are passed by tests / offline packaging.
 */
export function huggingFaceCacheDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const dirs = new Set<string>();
  const add = (value: string | undefined): void => {
    const trimmed = value?.trim();
    if (trimmed) dirs.add(path.resolve(trimmed));
  };
  add(env.HUGGINGFACE_HUB_CACHE);
  add(env.HF_HUB_CACHE);
  add(env.HF_HOME ? path.join(env.HF_HOME, 'hub') : undefined);
  add(env.XDG_CACHE_HOME ? path.join(env.XDG_CACHE_HOME, 'huggingface', 'hub') : undefined);
  add(path.join(homedir(), '.cache', 'huggingface', 'hub'));
  return [...dirs];
}

/** True when `directory` contains transformers weights (single file or sharded). */
export async function hasTransformersWeights(directory: string): Promise<boolean> {
  for (const name of ['model.safetensors', 'pytorch_model.bin', 'model.safetensors.index.json', 'pytorch_model.bin.index.json']) {
    if (await fileExists(path.join(directory, name))) return true;
  }
  return false;
}

/** True when `directory` contains a CTranslate2 `model.bin`. */
export async function hasCTranslate2Weights(directory: string): Promise<boolean> {
  return fileExists(path.join(directory, 'model.bin'));
}

/**
 * Finds a locally cached HuggingFace snapshot without network access.
 *
 * `requiredFiles` must all exist and, when `anyOfFiles` is non-empty, at least
 * one of them must exist as well (e.g. `config.json` + any weight file).
 */
export async function findHfCachedModel(
  repoId: string,
  requiredFiles: readonly string[],
  anyOfFiles: readonly string[] = [],
  cacheDirs: readonly string[] = huggingFaceCacheDirs(),
): Promise<string | null> {
  const repoDirectoryName = `models--${repoId.replace(/\//g, '--')}`;
  for (const cacheDir of cacheDirs) {
    const snapshotsDir = path.join(cacheDir, repoDirectoryName, 'snapshots');
    let entries: Array<{ isDirectory(): boolean; name: string }>;
    try {
      entries = await readdir(snapshotsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(snapshotsDir, entry.name);
      let complete = true;
      for (const file of requiredFiles) {
        if (!(await fileExists(path.join(directory, file)))) {
          complete = false;
          break;
        }
      }
      if (!complete) continue;
      if (anyOfFiles.length > 0) {
        let any = false;
        for (const file of anyOfFiles) {
          if (await fileExists(path.join(directory, file))) {
            any = true;
            break;
          }
        }
        if (!any) continue;
      }
      return directory;
    }
  }
  return null;
}

/**
 * Resolves a command to an absolute path when possible. Bare names are looked
 * up in `PATH` (plus `PATHEXT` on Windows); absolute/relative paths are checked
 * directly. Returns `null` when the executable cannot be found.
 */
export function findExecutable(command: string, pathValue = process.env.PATH ?? ''): string | null {
  const raw = command.trim();
  if (!raw) return null;
  const hasSeparator = raw.includes('/') || raw.includes('\\');
  if (hasSeparator || path.isAbsolute(raw)) {
    const resolved = path.resolve(raw);
    return existsSync(resolved) ? resolved : null;
  }
  const extensions =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
      : [''];
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const target =
        extension && !raw.toLowerCase().endsWith(extension.toLowerCase()) ? `${raw}${extension}` : raw;
      const candidate = path.join(directory, target);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** Runs a child process with a hard timeout; never throws on a non-zero exit. */
export function runProcess(
  command: string,
  args: readonly string[],
  options: { timeoutMs?: number; cwd?: string; env?: NodeJS.ProcessEnv; stdin?: string } = {},
): Promise<ProcessResult> {
  const timeoutMs = Math.max(250, Math.min(600_000, options.timeoutMs ?? 30_000));
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command, [...args], {
        cwd: options.cwd,
        env: options.env ?? process.env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(new LocalProcessError('not_found', `cannot start ${path.basename(command)}: ${String(error)}`));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const append = (current: string, chunk: Buffer): string => {
      if (current.length >= MAX_CAPTURED_OUTPUT) return current;
      const next = current + chunk.toString('utf8');
      return next.length > MAX_CAPTURED_OUTPUT ? next.slice(0, MAX_CAPTURED_OUTPUT) : next;
    };
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    timer.unref?.();

    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, durationMs: Date.now() - startedAt });
    };

    child.on('error', (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error.code === 'ENOENT') {
        reject(new LocalProcessError('not_found', `${path.basename(command)} is not installed or not on PATH`));
      } else {
        reject(new LocalProcessError('failed', `${path.basename(command)} failed: ${error.message}`));
      }
    });
    child.on('close', (code) => finish(code));
    if (options.stdin !== undefined) {
      child.stdin.end(options.stdin);
    } else {
      child.stdin.end();
    }
  });
}

/** Converts any supported audio buffer into 16 kHz mono PCM WAV for whisper. */
export async function convertToWav(
  audio: Buffer,
  mime: string,
  options: { workDir: string; ffmpegPath?: string | undefined; timeoutMs?: number },
): Promise<{ file: string; converted: boolean }> {
  const extension = extensionForMime(mime);
  const input = path.join(options.workDir, `input.${extension}`);
  await writeFile(input, audio);
  const ffmpeg = findExecutable(options.ffmpegPath?.trim() || 'ffmpeg');
  const output = path.join(options.workDir, 'audio.wav');
  if (!ffmpeg) {
    if (extension === 'wav') {
      // Last resort: pass the original WAV through. Engines may reject a
      // non-16 kHz file, but a clear engine error is better than a crash.
      await copyFile(input, output);
      return { file: output, converted: false };
    }
    throw new LocalProcessError(
      'ffmpeg_missing',
      'ffmpeg is required to convert browser audio (webm/opus) to 16 kHz WAV; install ffmpeg or send audio/wav',
    );
  }
  const result = await runProcess(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      input,
      '-ar',
      '16000',
      '-ac',
      '1',
      '-f',
      'wav',
      output,
    ],
    { timeoutMs: options.timeoutMs ?? 60_000 },
  );
  if (result.timedOut) throw new LocalProcessError('timeout', 'ffmpeg audio conversion timed out');
  if (result.code !== 0) {
    throw new LocalProcessError(
      'failed',
      `ffmpeg could not decode the audio (exit ${result.code})`,
      result.stderr.trim().slice(0, 300),
    );
  }
  return { file: output, converted: true };
}

export function extensionForMime(mime: string): string {
  const bare = mime.split(';')[0]?.trim().toLowerCase() ?? '';
  switch (bare) {
    case 'audio/wav':
    case 'audio/x-wav':
    case 'audio/wave':
      return 'wav';
    case 'audio/ogg':
      return 'ogg';
    case 'audio/mpeg':
    case 'audio/mp3':
      return 'mp3';
    case 'audio/mp4':
    case 'audio/x-m4a':
      return 'm4a';
    case 'audio/flac':
    case 'audio/x-flac':
      return 'flac';
    case 'audio/webm':
    default:
      return 'webm';
  }
}

export async function withTempDir<T>(prefix: string, run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Reads a file as text, returning `null` when it does not exist. */
export async function readTextIfExists(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

/** True when the current user can execute the file (best effort). */
export async function isExecutable(file: string): Promise<boolean> {
  try {
    await access(file, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Splits text into sentence-ish chunks no longer than `maxChars`.
 * Used to keep local MT requests inside model limits.
 */
export function chunkText(text: string, maxChars: number): string[] {
  const normalized = text.trim();
  if (!normalized) return [];
  const limit = Math.max(80, Math.min(4000, Math.trunc(maxChars) || 800));
  if (normalized.length <= limit) return [normalized];
  const sentences = normalized.match(/[^.!?…\n]+[.!?…]*\s*/g) ?? [normalized];
  const chunks: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    const piece = sentence.trim();
    if (!piece) continue;
    if (current && current.length + piece.length + 1 > limit) {
      chunks.push(current);
      current = '';
    }
    if (piece.length > limit) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      for (let index = 0; index < piece.length; index += limit) {
        chunks.push(piece.slice(index, index + limit));
      }
      continue;
    }
    current = current ? `${current} ${piece}` : piece;
  }
  if (current) chunks.push(current);
  return chunks;
}

/* ------------------------------------------------------------------ */
/* Persistent newline-delimited JSON worker                           */
/* ------------------------------------------------------------------ */

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * A long-lived Python worker speaking one JSON object per line.
 *
 * The worker prints a single `{"ready":true,...}` line on startup; afterwards
 * every request has an `id` and every response echoes it. Models stay loaded
 * between requests, which matters for faster-whisper and MarianMT.
 */
export class JsonLineWorker {
  readonly command: string;
  readonly args: readonly string[];
  private child: ChildProcessWithoutNullStreams | null = null;
  private readyPromise: Promise<Record<string, unknown>> | null = null;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private buffer = '';
  private closed = false;
  private stderrTail = '';
  private readonly requestTimeoutMs: number;
  private readonly environment: NodeJS.ProcessEnv | undefined;

  constructor(
    command: string,
    args: readonly string[],
    requestTimeoutMs = 120_000,
    options: { env?: NodeJS.ProcessEnv } = {},
  ) {
    this.command = command;
    this.args = args;
    this.requestTimeoutMs = Math.max(500, Math.min(600_000, requestTimeoutMs));
    this.environment = options.env;
  }

  isRunning(): boolean {
    return this.child !== null && !this.closed;
  }

  /** Starts the worker and waits for its `ready` line. */
  async start(): Promise<Record<string, unknown>> {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
      let settled = false;
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(this.command, [...this.args], {
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...(this.environment ?? process.env), PYTHONIOENCODING: 'utf-8' },
        });
      } catch (error) {
        reject(new LocalProcessError('not_found', `cannot start local worker: ${String(error)}`));
        return;
      }
      this.child = child;
      this.closed = false;
      const readyTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new LocalProcessError('timeout', 'local worker did not report ready in time'));
        if (this.child === child) this.stop();
      }, 60_000);
      readyTimer.unref?.();

      const onLine = (line: string): void => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let payload: unknown;
        try {
          payload = JSON.parse(trimmed);
        } catch {
          return;
        }
        if (typeof payload !== 'object' || payload === null) return;
        const record = payload as Record<string, unknown>;
        if (!settled && record.ready === true) {
          settled = true;
          clearTimeout(readyTimer);
          resolve(record);
          return;
        }
        if (!settled && record.ready === false) {
          settled = true;
          clearTimeout(readyTimer);
          const message = typeof record.error === 'string' ? record.error : 'local worker failed to start';
          reject(new LocalProcessError('failed', message));
          return;
        }
        const id = typeof record.id === 'number' ? record.id : null;
        if (id === null) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        if (record.ok === false) {
          const message = typeof record.error === 'string' ? record.error : 'local worker request failed';
          pending.reject(new Error(message));
        } else {
          pending.resolve(record);
        }
      };

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (this.child !== child) return;
        this.buffer += chunk;
        let newline = this.buffer.indexOf('\n');
        while (newline >= 0) {
          const line = this.buffer.slice(0, newline);
          this.buffer = this.buffer.slice(newline + 1);
          onLine(line);
          newline = this.buffer.indexOf('\n');
        }
        if (this.buffer.length > 4 * 1024 * 1024) this.buffer = '';
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        if (this.child !== child) return;
        this.stderrTail = `${this.stderrTail}${chunk}`.slice(-2000);
      });
      child.on('error', (error: NodeJS.ErrnoException) => {
        if (!settled) {
          settled = true;
          clearTimeout(readyTimer);
          reject(
            error.code === 'ENOENT'
              ? new LocalProcessError('not_found', `${path.basename(this.command)} is not installed`)
              : new LocalProcessError('failed', error.message),
          );
        }
        if (this.child === child) this.failAll(new Error(`local worker failed: ${error.message}`));
      });
      child.on('close', (code) => {
        if (!settled) {
          settled = true;
          clearTimeout(readyTimer);
          reject(
            new LocalProcessError(
              'failed',
              `local worker exited before ready (exit ${code ?? 'unknown'})`,
              this.stderrTail.trim().slice(-500),
            ),
          );
        }
        if (this.child !== child) return;
        this.closed = true;
        this.child = null;
        this.readyPromise = null;
        this.failAll(new Error(`local worker exited (exit ${code ?? 'unknown'})`));
      });
    });
    return this.readyPromise;
  }

  async request(payload: Record<string, unknown>, timeoutMs = this.requestTimeoutMs): Promise<Record<string, unknown>> {
    await this.start();
    const child = this.child;
    if (!child || this.closed) throw new LocalProcessError('failed', 'local worker is not running');
    const id = this.nextId++;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new LocalProcessError('timeout', 'local worker request timed out'));
      }, Math.max(500, timeoutMs));
      timer.unref?.();
      this.pending.set(id, { resolve: (value) => resolve(value as Record<string, unknown>), reject, timer });
      try {
        child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new LocalProcessError('failed', `cannot write to local worker: ${String(error)}`));
      }
    });
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  stop(): void {
    this.closed = true;
    this.readyPromise = null;
    this.failAll(new Error('local worker stopped'));
    const child = this.child;
    this.child = null;
    this.buffer = '';
    this.stderrTail = '';
    if (child) {
      // Python's Windows virtualenv launcher has a child that owns the pipes.
      // Let the worker observe EOF before terminating the launcher.
      const forceStop = setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        if (process.platform === 'win32' && child.pid) {
          const tree = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
            stdio: 'ignore', windowsHide: true,
          });
          tree.once('error', () => child.kill('SIGKILL'));
          tree.once('exit', (code) => { if (code !== 0) child.kill('SIGKILL'); });
        } else {
          child.kill('SIGKILL');
        }
      }, 3000);
      forceStop.unref();
      child.once('close', () => clearTimeout(forceStop));
      child.stdin.end();
    }
  }
}
