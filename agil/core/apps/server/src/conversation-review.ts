import { randomUUID } from 'node:crypto';
import type { ConversationReviewFinding, ConversationReviewPolicy, ConversationReviewReport, ServerMessage } from '@agil/protocol';
import type { Room, RoomConnection } from './rooms.js';

type Policy = Extract<ConversationReviewPolicy, { enabled: true }>;
type State = {
  revision: string;
  policy: Policy;
  rules: Array<{ rule: Policy['rules'][number]; pattern: RegExp }>;
  consent: WeakMap<RoomConnection, boolean>;
  findings: ConversationReviewFinding[];
};

const disabled = { type: 'conversation-review', revision: null, consent: 'pending' } as const;

function normalize(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
}

export class ConversationReview {
  private readonly rooms = new WeakMap<Room, State>();
  private readonly closed = new Map<string, { retentionMin: number; findings: ConversationReviewFinding[] }>();

  constructor(private readonly now = Date.now) {}

  configure(room: Room, policy: ConversationReviewPolicy): void {
    if (!policy.enabled) {
      if (this.rooms.delete(room)) room.broadcast(disabled);
      return;
    }
    const rules = policy.rules.map((rule) => {
      const literal = normalize(rule.phrase).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return { rule, pattern: new RegExp(`(?<![\\p{L}\\p{N}_])${literal}(?![\\p{L}\\p{N}_])`, 'u') };
    });
    const revision = randomUUID();
    this.rooms.set(room, { revision, policy, rules, consent: new WeakMap(), findings: [] });
    room.broadcast({ type: 'conversation-review', revision, consent: 'pending' });
  }

  status(room: Room, connection: RoomConnection): Extract<ServerMessage, { type: 'conversation-review' }> | undefined {
    const state = this.rooms.get(room);
    if (!state) return undefined;
    const consent = state.consent.get(connection);
    return { type: 'conversation-review', revision: state.revision,
      consent: consent === undefined ? 'pending' : consent ? 'allowed' : 'declined' };
  }

  consent(room: Room, connection: RoomConnection, revision: string, allowed: boolean): void {
    const state = this.rooms.get(room);
    if (!state || state.revision !== revision || connection.offline) return;
    if (!allowed && state.consent.get(connection) === true) state.findings.length = 0;
    state.consent.set(connection, allowed);
    const status = this.status(room, connection);
    if (status) connection.send(status);
  }

  inspect(room: Room, connection: RoomConnection, caption: string): void {
    const state = this.rooms.get(room);
    if (!state || state.consent.get(connection) !== true || room.closed) return;
    if (!room.participants().every(({ id }) => {
      const current = room.member(id)?.connection;
      return current && !current.offline && state.consent.get(current) === true;
    })) return;
    const text = normalize(caption);
    const now = this.now();
    for (const { rule, pattern } of state.rules) {
      if (!pattern.test(text) || state.findings.some((finding) => finding.ruleId === rule.id && now - finding.at < 15_000)) continue;
      state.findings.push({ ruleId: rule.id, category: rule.category, severity: rule.severity, at: now });
    }
    this.trim(state, now);
  }

  report(room: Room): ConversationReviewReport {
    const state = this.rooms.get(room);
    if (!state) return { policy: { enabled: false }, findings: [] };
    this.trim(state, this.now());
    return { policy: state.policy, findings: [...state.findings] };
  }

  closeRoom(room: Room, allowArchive: boolean): void {
    const key = JSON.stringify([room.tenantId, room.id]);
    this.closed.delete(key);
    const state = this.rooms.get(room);
    this.rooms.delete(room);
    if (!state || !allowArchive) return;
    this.trim(state, this.now());
    if (!state.findings.length) return;
    if (this.closed.size >= 500) this.closed.delete(this.closed.keys().next().value!);
    this.closed.set(key, { retentionMin: state.policy.retentionMin, findings: state.findings });
  }

  archived(tenantId: string, roomId: string): ConversationReviewReport | undefined {
    this.sweep();
    const archived = this.closed.get(JSON.stringify([tenantId, roomId]));
    return archived ? { policy: { enabled: false }, findings: [...archived.findings] } : undefined;
  }

  sweep(room?: Room): void {
    const now = this.now();
    if (room) {
      const state = this.rooms.get(room);
      if (state) this.trim(state, now);
      return;
    }
    for (const [key, state] of this.closed) {
      state.findings = state.findings.filter((finding) => finding.at > now - state.retentionMin * 60_000);
      if (!state.findings.length) this.closed.delete(key);
    }
  }

  private trim(state: State, now: number): void {
    const cutoff = now - state.policy.retentionMin * 60_000;
    state.findings = state.findings.filter((finding) => finding.at > cutoff).slice(-200);
  }
}
