/**
 * Chat injection: the company's backend, bot, CRM or host page can post a
 * message into the call without a WebSocket. The message is stored in the room
 * history, routed through the normal permission-checked `chat` signaling message,
 * audited (`chat.sent`) and forwarded to the
 * `chat.message` webhook.
 */
import { randomUUID } from 'node:crypto';
import type { ChatAttachment, ChatMessage, Role, ServerMessage, TenantConfig } from '@agil/protocol';
import type { Logger } from './logger.js';
import type { Room } from './rooms.js';
import type { Services } from './services.js';

export interface ChatActor {
  id: string;
  name: string;
  role: Role;
}

export interface PostChatInput {
  room: Room;
  services: Services;
  config: TenantConfig;
  actor: ChatActor;
  text: string;
  kind?: 'text' | 'system';
  attachment?: ChatAttachment;
  from?: { id?: string; name?: string; role?: Role };
  /** Idempotency key from the caller. */
  id?: string;
  /** Skip the audit line (used when the caller audits itself). */
  skipAudit?: boolean;
  logger?: Logger;
}

export interface PostChatResult {
  message: ChatMessage;
  duplicate: boolean;
}

/** Posts a chat message and fans it out; idempotent on `id`. */
export async function postChatMessage(input: PostChatInput): Promise<PostChatResult> {
  const { historyStorage, historyRetentionSec } = input.config.session.chat;
  const messageId = (input.id ?? randomUUID()).slice(0, 64);
  if (historyStorage === 'off') input.room.messages.length = 0;
  const existing = historyStorage === 'session'
    ? input.room.messages.find((message) => message.id === messageId)
    : undefined;
  if (existing) return { message: existing, duplicate: true };

  const actor = input.actor;
  const from = {
    id: (input.from?.id ?? actor.id).slice(0, 64),
    name: (input.from?.name ?? actor.name).slice(0, 120) || actor.name,
    role: input.from?.role ?? actor.role,
  };
  const text = input.text.slice(0, 4000);
  const message: ChatMessage = {
    id: messageId,
    roomId: input.room.id,
    from,
    text,
    ts: Date.now(),
    kind: input.kind === 'system' ? 'system' : input.attachment ? 'file' : 'text',
    ...(input.attachment ? { attachment: input.attachment } : {}),
  };

  if (historyStorage === 'local' || historyStorage === 'postgres') {
    const archived = await input.services.chatHistory.append(historyStorage, {
      tenantId: input.room.tenantId,
      roomId: input.room.id,
      roomInstanceId: input.room.chatHistoryInstanceId,
    }, message, historyRetentionSec);
    if (archived.duplicate) return archived;
  } else if (historyStorage === 'session') {
    input.room.addMessage(message);
  }
  const broadcast: ServerMessage = { type: 'chat', message };
  input.room.broadcast(broadcast);

  if (!input.skipAudit) {
    try {
      input.services.audit.append({
        type: 'chat.sent',
        severity: 'info',
        tenantId: input.room.tenantId,
        roomId: input.room.id,
        participantId: from.id,
        message: `Chat message injected (${input.kind ?? 'text'}, ${text.length} chars)`,
        details: { messageId, kind: message.kind, via: 'api' },
      });
    } catch (error) {
      input.logger?.warn('chat audit failed', { error: (error as Error).message });
    }
  }
  if (historyStorage !== 'off') {
    input.services.webhooks.emit('chat.message', { tenantId: input.room.tenantId, roomId: input.room.id }, {
      messageId,
      from,
      text: text.slice(0, 500),
      kind: message.kind,
      ts: message.ts,
    });
  }
  return { message, duplicate: false };
}
