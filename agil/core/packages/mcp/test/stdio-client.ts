/**
 * Minimal MCP stdio client used by the protocol-level tests.
 *
 * It spawns the *built* server (`dist/index.js`) exactly like Claude Desktop or
 * Cursor would and speaks line-delimited JSON-RPC 2.0 over stdin/stdout.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

export const DIST_ENTRY = fileURLToPath(new URL('../dist/index.js', import.meta.url));

export interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface PendingRequest {
  resolve: (message: JsonRpcMessage) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface StartOptions {
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

/** Finds a local TCP port that is definitely closed (for the offline test). */
export async function findClosedPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address === 'string' || address === null) {
        server.close();
        reject(new Error('Could not allocate a port'));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

export class McpStdioClient {
  private buffer = '';
  private stderr = '';
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private stopped = false;
  private exitError: Error | undefined;
  serverInfo: { name?: string; version?: string } = {};

  private constructor(
    private readonly proc: ChildProcessWithoutNullStreams,
    readonly timeoutMs: number,
  ) {
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => {
      this.stderr += chunk;
    });
    proc.once('exit', (code) => {
      if (this.stopped) return;
      this.exitError = new Error(`MCP server exited unexpectedly (code ${String(code)}). stderr:\n${this.stderr.slice(-4000)}`);
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(this.exitError);
        this.pending.delete(id);
      }
    });
  }

  static async start(options: StartOptions = {}): Promise<McpStdioClient> {
    if (!existsSync(DIST_ENTRY)) {
      throw new Error(`Built server not found at ${DIST_ENTRY}. Run: npm run build -w @agil/mcp`);
    }
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const [key, value] of Object.entries(options.env ?? {})) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
    const timeoutMs = options.timeoutMs ?? 15_000;
    const proc = spawn(process.execPath, [DIST_ENTRY], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const client = new McpStdioClient(proc, timeoutMs);
    const initialized = await client.request<{ serverInfo?: { name?: string; version?: string } }>('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'agil-mcp-tests', version: '0.0.0' },
    });
    client.serverInfo = initialized.serverInfo ?? {};
    client.notify('notifications/initialized', {});
    return client;
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let newlineIndex = this.buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      newlineIndex = this.buffer.indexOf('\n');
      if (!line) continue;
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(line) as JsonRpcMessage;
      } catch {
        throw new Error(`Non-JSON output on stdout (stdio protocol violation): ${line.slice(0, 500)}`);
      }
      if (typeof message.id === 'number' && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) {
          pending.reject(new Error(`JSON-RPC error ${message.error.code}: ${message.error.message}`));
        } else {
          pending.resolve(message);
        }
      }
    }
  }

  request<T = unknown>(method: string, params: unknown = {}, timeoutMs = this.timeoutMs): Promise<T> {
    if (this.exitError) return Promise.reject(this.exitError);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `Timeout after ${timeoutMs}ms waiting for "${method}". stderr tails:\n${this.stderr.slice(-2000)}`,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (message) => resolve(message.result as T),
        reject,
        timer,
      });
      this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  notify(method: string, params: unknown = {}): void {
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async listTools(): Promise<ToolInfo[]> {
    const result = await this.request<{ tools: ToolInfo[] }>('tools/list', {});
    return result.tools;
  }

  async callTool(name: string, args: unknown = {}): Promise<ToolCallResult> {
    return await this.request<ToolCallResult>('tools/call', { name, arguments: args });
  }

  async callToolJson<T = unknown>(name: string, args: unknown = {}): Promise<{ result: ToolCallResult; value: T }> {
    const result = await this.callTool(name, args);
    const textBlock = result.content.find((block) => block.type === 'text');
    if (!textBlock) throw new Error(`Tool ${name} returned no text content`);
    return { result, value: JSON.parse(textBlock.text) as T };
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Client stopped'));
      this.pending.delete(id);
    }
    this.proc.stdin.end();
    this.proc.kill();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2000);
      this.proc.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  get stderrText(): string {
    return this.stderr;
  }
}

export interface ToolInfo {
  name: string;
  title?: string;
  description?: string;
  inputSchema: { type?: string; properties?: Record<string, unknown>; [key: string]: unknown };
}

export interface ToolCallResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}
