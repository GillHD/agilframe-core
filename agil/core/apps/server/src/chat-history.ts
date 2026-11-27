import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatMessage } from '@agil/protocol';
import { writeJsonAtomic } from '@agil/security';
import type { ChatHistoryStore, ChatScope } from './chat-postgres.js';
import type { Logger } from './logger.js';

type ArchiveMode = 'local' | 'postgres';
type Entry = { roomInstanceId: string; expiresAt: number; message: ChatMessage };
const HISTORY_LIMIT = 200;

export class ChatStorageUnavailable extends Error {
  constructor() {
    super('Chat history storage is unavailable');
  }
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function readEntries(path: string): Entry[] {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(value)) throw new Error('Invalid chat history file');
    return value;
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
}

function pathsIn(path: string, directory: boolean): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => directory
        ? entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name)
        : entry.isFile() && /^[a-f0-9]{64}\.json$/.test(entry.name))
      .map((entry) => join(path, entry.name));
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
}

/** One Core writer per data directory. Each room keeps at most 200 records. */
class LocalChatHistory {
  constructor(private readonly root: string) {}

  private path(scope: ChatScope): { directory: string; file: string } {
    const hash = (id: string) => createHash('sha256').update(id).digest('hex');
    const directory = join(this.root, hash(scope.tenantId));
    return { directory, file: join(directory, `${hash(scope.roomId)}.json`) };
  }

  append(scope: ChatScope & { roomInstanceId: string }, message: ChatMessage, retentionSec: number) {
    const { directory, file } = this.path(scope);
    const now = Date.now();
    const entries = readEntries(file).filter((entry) => entry.expiresAt > now);
    const existing = entries.find((entry) => entry.roomInstanceId === scope.roomInstanceId && entry.message.id === message.id);
    if (existing) return { message: existing.message, duplicate: true };
    entries.push({ roomInstanceId: scope.roomInstanceId, expiresAt: now + retentionSec * 1000, message });
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeJsonAtomic(file, entries.slice(-HISTORY_LIMIT), 0o600);
    return { message, duplicate: false };
  }

  recent(scope: ChatScope, limit: number): ChatMessage[] {
    const now = Date.now();
    const entries = readEntries(this.path(scope).file).filter((entry) => entry.expiresAt > now);
    const roomInstanceId = scope.roomInstanceId ?? entries.at(-1)?.roomInstanceId;
    return entries.filter((entry) => entry.roomInstanceId === roomInstanceId)
      .slice(-limit)
      .map((entry) => entry.message);
  }

  sweepExpired(): void {
    const now = Date.now();
    for (const directory of pathsIn(this.root, true)) {
      for (const file of pathsIn(directory, false)) {
        const prior = readEntries(file);
        const remaining = prior.filter((entry) => entry.expiresAt > now);
        if (remaining.length === 0) rmSync(file, { force: true });
        else if (remaining.length < prior.length) writeJsonAtomic(file, remaining, 0o600);
      }
    }
  }
}

export class ChatHistory {
  private readonly local: LocalChatHistory;
  private postgres?: Promise<ChatHistoryStore>;
  private readonly timer: NodeJS.Timeout;
  private cleanup?: Promise<void>;

  constructor(directory: string, private readonly postgresUrl: string, private readonly logger: Logger) {
    this.local = new LocalChatHistory(directory);
    this.timer = setInterval(() => {
      if (this.cleanup) return;
      this.cleanup = this.sweep().finally(() => { this.cleanup = undefined; });
    }, 60_000).unref();
  }

  private database(): Promise<ChatHistoryStore> {
    if (!this.postgresUrl) throw new ChatStorageUnavailable();
    this.postgres ??= import('./chat-postgres.js')
      .then(({ openPostgresChatStore }) => openPostgresChatStore(this.postgresUrl))
      .catch(() => {
        this.postgres = undefined;
        throw new ChatStorageUnavailable();
      });
    return this.postgres;
  }

  async append(mode: ArchiveMode, scope: ChatScope & { roomInstanceId: string }, message: ChatMessage, retentionSec: number) {
    // Persist attachment captions without copying signed file URLs into another store.
    const { attachment, ...caption } = message;
    const archived: ChatMessage = attachment
      ? { ...caption, text: caption.text || attachment.name, kind: 'text' }
      : message;
    try {
      return mode === 'local'
        ? this.local.append(scope, archived, retentionSec)
        : await (await this.database()).append(scope, archived, retentionSec);
    } catch {
      throw new ChatStorageUnavailable();
    }
  }

  async recent(mode: ArchiveMode, scope: ChatScope, limit: number): Promise<ChatMessage[]> {
    const size = Math.min(HISTORY_LIMIT, Math.max(1, limit));
    try {
      return mode === 'local' ? this.local.recent(scope, size) : await (await this.database()).recent(scope, size);
    } catch {
      throw new ChatStorageUnavailable();
    }
  }

  private async sweep(): Promise<void> {
    try {
      this.local.sweepExpired();
    } catch {
      this.logger.warn('Local chat history cleanup failed');
    }
    if (this.postgresUrl) {
      try {
        await (await this.database()).sweepExpired();
      } catch {
        this.logger.warn('PostgreSQL chat history cleanup failed');
      }
    }
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    await this.cleanup;
    const database = await this.postgres?.catch(() => undefined);
    await database?.close();
  }
}
