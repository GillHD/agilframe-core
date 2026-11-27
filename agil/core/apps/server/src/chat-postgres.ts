import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import type { ChatMessage } from '@agil/protocol';

export interface ChatScope {
  tenantId: string;
  roomId: string;
  /** Required for writes and active rooms. Omitted only when reading the closed-room archive. */
  roomInstanceId?: string;
}

export interface ChatHistoryStore {
  append(scope: ChatScope, message: ChatMessage, retentionSec: number): Promise<{ message: ChatMessage; duplicate: boolean }>;
  /** Returns up to 200 unexpired messages from one room instance, in conversation order. */
  recent(scope: ChatScope, limit: number): Promise<ChatMessage[]>;
  purge(scope: { tenantId: string; roomId?: string }): Promise<number>;
  sweepExpired(): Promise<number>;
  close(): Promise<void>;
}

export class PostgresChatStoreError extends Error {
  readonly code = 'chat_storage_unavailable';

  constructor() {
    super('PostgreSQL chat storage is unavailable');
    this.name = 'PostgresChatStoreError';
  }
}

type MessageRow = { payload: ChatMessage };

const INSERT = `
  INSERT INTO agil_chat_messages AS history
    (tenant_id, room_id, room_instance_id, message_id, sent_at_ms, expires_at, payload)
  VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP + $6::int * INTERVAL '1 second', $7::jsonb)
  ON CONFLICT (tenant_id, room_id, room_instance_id, message_id) DO UPDATE SET
    sent_at_ms = EXCLUDED.sent_at_ms,
    stored_at = EXCLUDED.stored_at,
    expires_at = EXCLUDED.expires_at,
    payload = EXCLUDED.payload
  WHERE history.expires_at <= CURRENT_TIMESTAMP
  RETURNING payload`;

const READ_DUPLICATE = `
  SELECT payload FROM agil_chat_messages
  WHERE tenant_id = $1 AND room_id = $2 AND room_instance_id = $3 AND message_id = $4
    AND expires_at > CURRENT_TIMESTAMP`;

const RECENT = `
  SELECT payload FROM agil_chat_messages
  WHERE tenant_id = $1 AND room_id = $2 AND room_instance_id = $3 AND expires_at > CURRENT_TIMESTAMP
  ORDER BY sent_at_ms DESC, message_id DESC
  LIMIT $4`;

const RECENT_ARCHIVE = `
  SELECT payload FROM agil_chat_messages
  WHERE tenant_id = $1 AND room_id = $2 AND expires_at > CURRENT_TIMESTAMP
    AND room_instance_id = (
      SELECT room_instance_id FROM agil_chat_messages
      WHERE tenant_id = $1 AND room_id = $2 AND expires_at > CURRENT_TIMESTAMP
      ORDER BY stored_at DESC, room_instance_id DESC
      LIMIT 1
    )
  ORDER BY sent_at_ms DESC, message_id DESC
  LIMIT $3`;

class PostgresChatHistory implements ChatHistoryStore {
  private closing?: Promise<void>;

  constructor(private readonly pool: Pool) {}

  async append(scope: ChatScope, message: ChatMessage, retentionSec: number): Promise<{ message: ChatMessage; duplicate: boolean }> {
    if (!scope.roomInstanceId || scope.roomId !== message.roomId || !Number.isSafeInteger(message.ts) || !Number.isInteger(retentionSec) ||
        retentionSec < 1 || retentionSec > 2_147_483_647) {
      throw new TypeError('Invalid PostgreSQL chat message scope, timestamp, or retention');
    }
    const client = await this.pool.connect().catch(() => {
      throw new PostgresChatStoreError();
    });
    let discard = false;
    const markDisconnected = (): void => { discard = true; };
    client.on('error', markDisconnected);
    try {
      // Keep the conflicting row locked while checking its canonical payload.
      // READ COMMITTED gives the second statement a snapshot of the winning write.
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      const key = [scope.tenantId, scope.roomId, scope.roomInstanceId, message.id];
      const inserted = await client.query<MessageRow>(INSERT, [...key, message.ts, retentionSec, JSON.stringify(message)]);
      const duplicate = inserted.rows.length === 0;
      const row = inserted.rows[0] ?? (await client.query<MessageRow>(READ_DUPLICATE, key)).rows[0];
      if (!row) throw new PostgresChatStoreError();
      await client.query('COMMIT');
      return { message: row.payload, duplicate };
    } catch {
      try {
        await client.query('ROLLBACK');
      } catch {
        discard = true;
      }
      throw new PostgresChatStoreError();
    } finally {
      client.off('error', markDisconnected);
      client.release(discard);
    }
  }

  async recent(scope: ChatScope, limit: number): Promise<ChatMessage[]> {
    const count = Number.isFinite(limit) ? Math.min(200, Math.max(0, Math.trunc(limit))) : 0;
    if (count === 0) return [];
    const { tenantId, roomId, roomInstanceId } = scope;
    const query = roomInstanceId === undefined
      ? this.pool.query<MessageRow>(RECENT_ARCHIVE, [tenantId, roomId, count])
      : this.pool.query<MessageRow>(RECENT, [tenantId, roomId, roomInstanceId, count]);
    const result = await query.catch(() => {
      throw new PostgresChatStoreError();
    });
    return result.rows.reverse().map(({ payload }) => payload);
  }

  async purge(scope: { tenantId: string; roomId?: string }): Promise<number> {
    const room = scope.roomId;
    const result = (room === undefined
      ? this.pool.query('DELETE FROM agil_chat_messages WHERE tenant_id = $1', [scope.tenantId])
      : this.pool.query('DELETE FROM agil_chat_messages WHERE tenant_id = $1 AND room_id = $2', [scope.tenantId, room]))
      .catch(() => { throw new PostgresChatStoreError(); });
    return (await result).rowCount ?? 0;
  }

  async sweepExpired(): Promise<number> {
    const result = await this.pool.query('DELETE FROM agil_chat_messages WHERE expires_at <= CURRENT_TIMESTAMP').catch(() => {
      throw new PostgresChatStoreError();
    });
    return result.rowCount ?? 0;
  }

  close(): Promise<void> {
    this.closing ??= this.pool.end().catch(() => { throw new PostgresChatStoreError(); });
    return this.closing;
  }
}

/** Opens the opt-in store and applies its idempotent schema before serving chat. */
export async function openPostgresChatStore(databaseUrl: string): Promise<ChatHistoryStore> {
  const url = databaseUrl.trim();
  if (!URL.canParse(url) || !['postgres:', 'postgresql:'].includes(new URL(url).protocol)) {
    throw new PostgresChatStoreError();
  }
  const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 5_000, statement_timeout: 10_000 });
  // Idle connections may fail outside a request. pg removes them from the pool;
  // the next operation reports a sanitized error if the server is unavailable.
  pool.on('error', () => {});
  try {
    const schema = await readFile(new URL('../migrations/001-chat-messages.sql', import.meta.url), 'utf8');
    await pool.query(schema);
    return new PostgresChatHistory(pool);
  } catch {
    await pool.end().catch(() => {});
    throw new PostgresChatStoreError();
  }
}
