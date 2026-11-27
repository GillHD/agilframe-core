/**
 * In-memory room registry.
 *
 * A room owns everything that lives for the duration of a call: participants,
 * chat history (last 200 messages), transcript segments, live captions,
 * compliance findings / meeting notes, join-failure lockout state and the TTL
 * sweeper that removes empty rooms. Persistence, broadcasting and auth live in
 * the HTTP/signaling layers; broadcast helpers only need a
 * {@link RoomConnection} handle per participant.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  resolveTenantConfig,
  type ChatMessage,
  type ComplianceFinding,
  type ComplianceReport,
  type FeatureKey,
  type RoomPoll,
  type BreakoutPlan,
  type MeetingNotes,
  type MediaMode,
  type Participant,
  type ParticipantState,
  type Role,
  type RoomContext,
  type RoomInfo,
  type RoomMode,
  type ServerMessage,
  type TenantConfig,
  type TenantConfigPatch,
  type TranscriptSegment,
} from '@agil/protocol';
import { RoomAnnotations, RoomWhiteboard } from './whiteboard.js';

export const MAX_CHAT_HISTORY = 200;
/** Hard cap for stored transcript segments (memory guard; admin API returns them all). */
export const MAX_TRANSCRIPT_SEGMENTS = 5000;
/** Hard cap for compliance findings kept per room. */
export const MAX_FINDINGS = 500;
const MAX_JOIN_ATTEMPT_KEYS = 2000;
const ROOM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isValidRoomId(id: string): boolean {
  return typeof id === 'string' && ROOM_ID_RE.test(id);
}

/** Room-specific failure (invalid id, duplicate, ...) translated to HTTP by the API layer. */
export class RoomRegistryError extends Error {
  readonly code: 'invalid_room_id' | 'room_exists' | 'room_not_found';
  constructor(code: RoomRegistryError['code'], message?: string) {
    super(message ?? code);
    this.name = 'RoomRegistryError';
    this.code = code;
  }
}

/** Minimal transport handle the room needs to push messages to a participant. */
export interface RoomConnection {
  send(message: ServerMessage): void;
  close(code: number, reason?: string): void;
  /** Pseudonymised IP (sha256), never the raw address. */
  ipHash?: string;
  /** Company-defined custom role id attached to the participant token. */
  roleId?: string;
  country?: string;
  locale?: 'ru' | 'en';
  joinedAt: number;
  /**
   * Placeholder connection recreated from a persisted snapshot on Core
   * restart: it has no live socket until the participant resumes
   * (docs/call-continuity.md). `send`/`close` are no-ops.
   */
  offline?: boolean;
  /**
   * Epoch ms until which an offline member still owns a room seat (resume-grace
   * lease). Restored snapshot members have no reservation.
   * See {@link Room.seatedParticipantCount}.
   */
  seatReservedUntil?: number;
  /** Socket opted into the resume grace lease (`?resume=1`). */
  resumeCapable?: boolean;
  /** sha256 of the last issued resume token (never the token itself). */
  resumeTokenHash?: string;
  /** Expiry of the last issued resume token (epoch ms). */
  resumeExpiresAt?: number;
  /**
   * sha256 of the previous resume token. A reconnect rotates the token, so one
   * previous hash is kept to survive a lost `welcome`.
   */
  resumeTokenHashPrev?: string;
  resumeExpiresAtPrev?: number;
}

export interface RoomMember {
  participant: Participant;
  connection: RoomConnection;
}

/** Explicit participant consent to server STT / transcript storage. */
export interface TranscriptConsent {
  participantId: string;
  grantedAt: number;
  /** Who recorded it (`self` for the participant, an admin id otherwise). */
  by: string;
}

export interface LiveCaption {
  participantId: string;
  participantName: string;
  text: string;
  isFinal: boolean;
  lang?: 'ru' | 'en';
  ts: number;
}

/** Precise GPS fix — server-side only, never broadcast with coordinates. */
export interface GpsLocation {
  lat: number;
  lon: number;
  accuracyM?: number;
  ts: number;
}

export interface JoinAttemptState {
  failures: number;
  lockedUntil: number;
  lastAt: number;
}

export interface CreateRoomInput {
  id?: string;
  tenantId: string;
  name: string;
  maxParticipants: number;
  ttlSec?: number;
  /** scrypt hash; the plain password never reaches this layer. */
  passwordHash?: string;
  configOverrides?: TenantConfigPatch;
  createdAt?: number;
  /** Internal generation, supplied only when restoring a snapshot. */
  chatHistoryInstanceId?: string;
  /** 'direct' (messenger 1:1 call) or 'group' (default). */
  mode?: RoomMode;
  /** Messenger context (conversation id, title, ...) — never secrets. */
  context?: RoomContext;
  allowedParticipantIds?: readonly string[];
  /** A voice channel's private runtime room is recreated on a fresh grant after a Core restart. */
  voiceChannel?: { id: string; revision: string };
  /** Effective media plane resolved from `config.scale` at creation time. */
  mediaMode?: MediaMode;
  /** Child breakout room marker: hidden from the main admin rooms list/capacity. */
  breakoutParentId?: string;
  /** SFU node the room is pinned to (set by the continuity allocator). */
  sfuNodeId?: string;
  /** Set while the node drains: the room stays joinable (docs/call-continuity.md). */
  draining?: boolean;
}

export const allowedParticipantIdsSchema = z.array(z.string().min(1).max(64).refine((id) => id === id.trim())).min(1).max(50000);

export interface BroadcastOptions {
  /** Skip this participant (the author, usually). */
  except?: string;
  /** Restrict to specific roles (e.g. compliance findings for moderators). */
  roles?: Role[];
}

export interface LockoutOptions {
  maxAttempts: number;
  lockoutSec: number;
  now?: number;
}

export interface LockoutStatus {
  locked: boolean;
  retryAfterMs: number;
}

export interface FailureResult {
  attempts: number;
  locked: boolean;
  lockedUntil: number;
}

export interface LobbyRequestInput {
  participantId: string;
  name: string;
  country?: string;
  ipHash: string;
  passwordAccepted: boolean;
  role: Role;
  roleId?: string;
  /** Token-pinned features inherited from a verified OIDC identity. */
  tokenPermissions?: FeatureKey[];
}

/** Pending waiting-room join request (never contains passwords/tokens). */
export interface LobbyRequest {
  id: string;
  cancelToken: string;
  roomId: string;
  participantId: string;
  name: string;
  country?: string;
  createdAt: number;
  expiresAt: number;
  ipHash: string;
  passwordAccepted: boolean;
  role: Role;
  roleId?: string;
  tokenPermissions?: FeatureKey[];
}

export interface LobbyDecision {
  status: 'admitted' | 'rejected' | 'expired';
  createdAt: number;
  token?: string;
  expiresAt?: number;
  joinUrl?: string;
  embedUrl?: string;
  reason?: string;
}

export class RoomLobbyError extends Error {
  readonly code: 'lobby_full' | 'lobby_not_found';
  constructor(code: RoomLobbyError['code'], message: string) {
    super(message);
    this.name = 'RoomLobbyError';
    this.code = code;
  }
}

export interface RoomPollOptionInput {
  text: string;
}

export interface RoomPollCreateInput {
  question: string;
  options: RoomPollOptionInput[];
  multiple: boolean;
  anonymous: boolean;
  kind: 'poll' | 'qna';
  createdBy: { id: string; name: string; role: string };
}

export interface RoomPollRecord {
  id: string;
  question: string;
  options: Array<{ id: string; text: string }>;
  multiple: boolean;
  anonymous: boolean;
  kind: 'poll' | 'qna';
  status: 'open' | 'closed';
  createdBy: { id: string; name: string; role: string };
  createdAt: number;
  closedAt?: number;
  /** participantId -> selected option ids (one vote per participant). */
  votes: Map<string, string[]>;
}

export class RoomPollError extends Error {
  readonly code: 'poll_not_found' | 'poll_closed' | 'poll_limit';
  constructor(code: RoomPollError['code'], message: string) {
    super(message);
    this.name = 'RoomPollError';
    this.code = code;
  }
}

export const MAX_ROOM_POLLS = 50;

export type RoomCloseListener = (roomId: string) => void;

/**
 * Placeholder transport for a participant without a live socket: a restored
 * snapshot member or one inside the resume-grace window. Nothing is buffered —
 * callers replay state via `welcome`, chat history and snapshot frames.
 */
export function offlineConnection(meta: {
  joinedAt: number;
  resumeCapable?: boolean;
  resumeTokenHash?: string;
  resumeExpiresAt?: number;
  resumeTokenHashPrev?: string;
  resumeExpiresAtPrev?: number;
  seatReservedUntil?: number;
  roleId?: string;
}): RoomConnection {
  return {
    send: () => undefined,
    close: () => undefined,
    joinedAt: meta.joinedAt,
    offline: true,
    ...(meta.resumeCapable ? { resumeCapable: true } : {}),
    ...(meta.resumeTokenHash ? { resumeTokenHash: meta.resumeTokenHash } : {}),
    ...(meta.resumeExpiresAt ? { resumeExpiresAt: meta.resumeExpiresAt } : {}),
    ...(meta.resumeTokenHashPrev ? { resumeTokenHashPrev: meta.resumeTokenHashPrev } : {}),
    ...(meta.resumeExpiresAtPrev ? { resumeExpiresAtPrev: meta.resumeExpiresAtPrev } : {}),
    ...(meta.seatReservedUntil ? { seatReservedUntil: meta.seatReservedUntil } : {}),
    ...(meta.roleId ? { roleId: meta.roleId } : {}),
  };
}

/**
 * Room lifecycle events consumed by metering (billing) and analytics.
 * Emitted by {@link RoomRegistry}; subscriber failures never break the call.
 */
export type RoomLifecycleEvent =
  | { type: 'created'; room: Room }
  | { type: 'joined'; room: Room; participantId: string }
  | { type: 'left'; room: Room; participantId: string }
  /** A dropped participant resumed without a new join (continuity). */
  | { type: 'resumed'; room: Room; participantId: string }
  /** A room snapshot was restored after a Core restart (continuity). */
  | { type: 'restored'; room: Room }
  | { type: 'closed'; room: Room; reason: string };

export class Room {
  readonly id: string;
  readonly tenantId: string;
  readonly createdAt: number;
  readonly chatHistoryInstanceId: string;
  name: string;
  locked = false;
  passwordHash?: string;
  maxParticipants: number;
  ttlSec: number;
  lastActivityAt: number;
  configOverrides?: TenantConfigPatch;
  readonly mode: RoomMode;
  readonly context?: RoomContext;
  readonly allowedParticipantIds?: ReadonlySet<string>;
  readonly voiceChannel?: CreateRoomInput['voiceChannel'];
  readonly mediaMode: MediaMode;
  /** Child breakout room marker: hidden from the main admin rooms list/capacity. */
  readonly breakoutParentId?: string;
  /** SFU node this room is pinned to (null for mesh rooms / before allocation). */
  sfuNodeId?: string;
  /** True while this room's SFU node drains; joins stay allowed. */
  draining = false;
  /** Active/last breakout plan for this (main) room; plans live in memory only. */
  breakoutPlan: BreakoutPlan | null = null;
  /** In-memory whiteboard state (bounded; optional `features.whiteboard`). */
  readonly whiteboard: RoomWhiteboard;
  /** Screen-share annotations for the current presenter (optional `features.annotations`). */
  readonly annotations: RoomAnnotations;

  /** Waiting-room queue (waitingRoom=true): pending join requests, in-memory. */
  readonly lobby = new Map<string, LobbyRequest>();
  /** Final decisions kept briefly so the guest can poll admitted/rejected. */
  readonly lobbyDecisions = new Map<string, LobbyDecision>();
  /** Expired request ids awaiting an audit entry (drained by the HTTP layer). */
  readonly expiredLobbyIds: string[] = [];
  readonly messages: ChatMessage[] = [];
  readonly segments: TranscriptSegment[] = [];
  /**
   * Explicit participant consent for server STT / transcript storage.
   * In-memory like the transcript itself: a room restart clears both.
   */
  readonly transcriptConsents = new Map<string, TranscriptConsent>();
  private analysisFindings: Array<{ finding: ComplianceFinding; storedAt: number }> = [];
  readonly captions = new Map<string, LiveCaption>();
  /** Consent-based GPS fixes; coordinates stay server-side (admin API only). */
  readonly gpsLocations = new Map<string, GpsLocation>();
  readonly joinAttempts = new Map<string, JoinAttemptState>();

  notes: MeetingNotes | null = null;
  report: ComplianceReport | null = null;
  analysisUpdatedAt = 0;

  private readonly members = new Map<string, RoomMember>();
  private ttlTimer: NodeJS.Timeout | null = null;
  private durationTimer: NodeJS.Timeout | null = null;
  durationDeadlineAt?: number;
  private closedFlag = false;
  /** Set by the registry; emits joined/left/resumed lifecycle events. */
  onMemberEvent?: (type: 'joined' | 'left' | 'resumed', participantId: string) => void;

  constructor(input: CreateRoomInput, defaults: { ttlSec: number; now: () => number }) {
    this.id = input.id ?? randomUUID();
    this.tenantId = input.tenantId;
    this.name = input.name;
    this.whiteboard = new RoomWhiteboard(this.id);
    this.annotations = new RoomAnnotations(this.id);
    this.createdAt = input.createdAt ?? defaults.now();
    this.chatHistoryInstanceId = input.chatHistoryInstanceId ?? randomUUID();
    this.maxParticipants = input.maxParticipants;
    this.ttlSec = input.ttlSec ?? defaults.ttlSec;
    this.passwordHash = input.passwordHash;
    this.configOverrides = input.configOverrides;
    this.mode = input.mode ?? 'group';
    this.context = input.context;
    if (input.allowedParticipantIds) this.allowedParticipantIds = new Set(input.allowedParticipantIds);
    this.voiceChannel = input.voiceChannel;
    this.mediaMode = input.mediaMode ?? 'mesh';
    this.breakoutParentId = input.breakoutParentId;
    this.sfuNodeId = input.sfuNodeId;
    this.draining = Boolean(input.draining);
    this.lastActivityAt = this.createdAt;
    this.scheduleTtl();
  }

  allowsParticipant(signedParticipantId?: string): boolean {
    return !this.allowedParticipantIds || (signedParticipantId !== undefined && this.allowedParticipantIds.has(signedParticipantId));
  }

  /* -------------------------- waiting room / lobby -------------------------- */

  private pruneLobby(now = Date.now()): void {
    for (const [id, request] of this.lobby) {
      if (request.expiresAt <= now) {
        this.lobby.delete(id);
        this.lobbyDecisions.set(id, { status: 'expired', createdAt: now });
        this.expiredLobbyIds.push(id);
      }
    }
    for (const [id, decision] of this.lobbyDecisions) {
      if (now - decision.createdAt > 10 * 60_000) this.lobbyDecisions.delete(id);
      else if (decision.status === 'admitted' && decision.token && decision.expiresAt !== undefined && decision.expiresAt <= now) {
        this.lobbyDecisions.set(id, { status: 'expired', createdAt: decision.createdAt });
      }
    }
  }

  addLobbyRequest(input: LobbyRequestInput, ttlSec: number, maxRequests: number): LobbyRequest {
    this.pruneLobby();
    if (this.lobby.size >= maxRequests) throw new RoomLobbyError('lobby_full', 'Waiting room is full');
    const now = Date.now();
    const request: LobbyRequest = {
      id: randomUUID(),
      cancelToken: randomUUID(),
      roomId: this.id,
      participantId: input.participantId,
      name: input.name.slice(0, 120),
      ...(input.country ? { country: input.country } : {}),
      createdAt: now,
      expiresAt: now + Math.max(1, ttlSec) * 1000,
      ipHash: input.ipHash,
      passwordAccepted: input.passwordAccepted,
      role: input.role,
      ...(input.roleId ? { roleId: input.roleId } : {}),
      ...(input.tokenPermissions && input.tokenPermissions.length > 0 ? { tokenPermissions: [...input.tokenPermissions] } : {}),
    };
    this.lobby.set(request.id, request);
    return request;
  }

  lobbyList(): LobbyRequest[] {
    this.pruneLobby();
    return [...this.lobby.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  lobbyCount(): number {
    this.pruneLobby();
    return this.lobby.size;
  }

  lobbyRequest(id: string): LobbyRequest | undefined {
    this.pruneLobby();
    return this.lobby.get(id);
  }

  removeLobbyRequest(id: string): LobbyRequest | undefined {
    const request = this.lobby.get(id);
    if (request) this.lobby.delete(id);
    return request;
  }

  recordLobbyDecision(id: string, decision: Omit<LobbyDecision, 'createdAt'>): void {
    this.lobbyDecisions.set(id, { ...decision, createdAt: Date.now() });
  }

  lobbyDecision(id: string): LobbyDecision | undefined {
    this.pruneLobby();
    return this.lobbyDecisions.get(id);
  }

  /** Expired request ids since the last drain (for lobby.expired audit). */
  takeExpiredLobbyIds(): string[] {
    return this.expiredLobbyIds.splice(0, this.expiredLobbyIds.length);
  }

  /** Returns the admitted token exactly once (guest polling). */
  takeLobbyToken(id: string): string | undefined {
    const decision = this.lobbyDecisions.get(id);
    if (!decision || decision.status !== 'admitted' || !decision.token) return undefined;
    const token = decision.token;
    delete decision.token;
    delete decision.joinUrl;
    delete decision.embedUrl;
    return token;
  }

  /* ------------------------------- polls / Q&A ------------------------------ */

  private readonly pollStore = new Map<string, RoomPollRecord>();

  createPoll(input: RoomPollCreateInput): RoomPollRecord {
    if (this.pollStore.size >= MAX_ROOM_POLLS) throw new RoomPollError('poll_limit', 'Poll limit reached');
    const poll: RoomPollRecord = {
      id: randomUUID(),
      question: input.question.slice(0, 500),
      options: input.options.map((option) => ({ id: randomUUID(), text: option.text.slice(0, 200) })),
      multiple: input.multiple,
      anonymous: input.anonymous,
      kind: input.kind,
      status: 'open',
      createdBy: input.createdBy,
      createdAt: Date.now(),
      votes: new Map(),
    };
    this.pollStore.set(poll.id, poll);
    return poll;
  }

  pollRecords(): RoomPollRecord[] {
    return [...this.pollStore.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  pollRecord(pollId: string): RoomPollRecord | undefined {
    return this.pollStore.get(pollId);
  }

  /** Participant-facing view: results + personal selected/voted flags. */
  pollView(poll: RoomPollRecord, viewerId?: string): RoomPoll {
    const totalVotes = poll.votes.size;
    const selected = viewerId ? new Set(poll.votes.get(viewerId) ?? []) : new Set<string>();
    return {
      id: poll.id,
      roomId: this.id,
      tenantId: this.tenantId,
      question: poll.question,
      options: poll.options.map((option) => {
        const votes = [...poll.votes.values()].filter((ids) => ids.includes(option.id)).length;
        return {
          id: option.id,
          text: option.text,
          votes,
          share: totalVotes > 0 ? votes / totalVotes : 0,
          ...(viewerId ? { selected: selected.has(option.id) } : {}),
        };
      }),
      multiple: poll.multiple,
      anonymous: poll.anonymous,
      kind: poll.kind,
      status: poll.status,
      createdBy: poll.createdBy,
      createdAt: poll.createdAt,
      ...(poll.closedAt ? { closedAt: poll.closedAt } : {}),
      totalVotes,
      ...(viewerId ? { voted: poll.votes.has(viewerId) } : {}),
    };
  }

  votePoll(pollId: string, participantId: string, optionIds: string[]): { accepted: boolean; reason?: string } {
    const poll = this.pollStore.get(pollId);
    if (!poll) throw new RoomPollError('poll_not_found', 'Poll not found');
    if (poll.status === 'closed') throw new RoomPollError('poll_closed', 'Poll is closed');
    if (poll.votes.has(participantId)) return { accepted: false, reason: 'already_voted' };
    const unique = [...new Set(optionIds)];
    if (unique.length === 0) return { accepted: false, reason: 'invalid_option' };
    if (!poll.multiple && unique.length > 1) return { accepted: false, reason: 'single_choice_only' };
    const valid = new Set(poll.options.map((option) => option.id));
    if (unique.some((id) => !valid.has(id))) return { accepted: false, reason: 'invalid_option' };
    poll.votes.set(participantId, unique);
    return { accepted: true };
  }

  closePoll(pollId: string): RoomPollRecord {
    const poll = this.pollStore.get(pollId);
    if (!poll) throw new RoomPollError('poll_not_found', 'Poll not found');
    if (poll.status !== 'closed') {
      poll.status = 'closed';
      poll.closedAt = Date.now();
    }
    return poll;
  }

  get closed(): boolean {
    return this.closedFlag;
  }

  get passwordProtected(): boolean {
    return Boolean(this.passwordHash);
  }

  get participantCount(): number {
    return this.members.size;
  }

  /**
   * Participants that actually occupy a room seat right now: live sockets plus
   * offline members still inside an active resume-grace lease. Restored
   * snapshot members are excluded (docs/call-continuity.md).
   */
  seatedParticipantCount(now = Date.now()): number {
    let seated = 0;
    for (const member of this.members.values()) {
      if (!member.connection.offline || (member.connection.seatReservedUntil ?? 0) > now) seated += 1;
    }
    return seated;
  }

  get isFull(): boolean {
    return this.seatedParticipantCount() >= this.maxParticipants;
  }

  info(): RoomInfo {
    return {
      id: this.id,
      tenantId: this.tenantId,
      name: this.name,
      createdAt: this.createdAt,
      locked: this.locked,
      mode: this.mode,
      ...(this.context ? { context: this.context } : {}),
      mediaMode: this.mediaMode,
      maxParticipants: this.maxParticipants,
      ...(this.draining ? { draining: true } : {}),
      ...(this.sfuNodeId ? { sfuNodeId: this.sfuNodeId } : {}),
    };
  }

  /** Stable participant list (insertion order = join order). */
  participants(): Participant[] {
    return [...this.members.values()].map((member) => member.participant);
  }

  /** Custom role ids currently used by connected participants (for admin role stats). */
  participantRoleIds(): string[] {
    const ids: string[] = [];
    for (const member of this.members.values()) {
      if (member.connection.roleId) ids.push(member.connection.roleId);
    }
    return ids;
  }

  member(participantId: string): RoomMember | undefined {
    return this.members.get(participantId);
  }

  /**
   * True when the participant is only held by a resume lease / restored
   * snapshot (no live socket). Reconnect paths check this before announcing a
   * leave or a duplicate join (docs/call-continuity.md).
   */
  isOffline(participantId: string): boolean {
    const member = this.members.get(participantId);
    return Boolean(member?.connection.offline);
  }

  /**
   * Adds a participant. When the same id reconnects, the previous connection is
   * closed with `1000 replaced` and returned so the caller can broadcast.
   */
  addMember(participant: Participant, connection: RoomConnection): { replaced: RoomConnection | null } {
    this.clearTtl();
    const previous = this.members.get(participant.id);
    if (previous) {
      try {
        previous.connection.close(1000, 'replaced');
      } catch {
        /* already gone */
      }
    }
    this.members.set(participant.id, {
      participant: { ...participant, presence: 'online' },
      connection,
    });
    this.lastActivityAt = Date.now();
    this.emitMember('joined', participant.id);
    return { replaced: previous?.connection ?? null };
  }

  /**
   * Swaps a reconnecting participant onto a new socket without emitting a
   * join/leave, keeping the original `joinedAt` and media state. Returns
   * `resumed: false` when the member is already gone (the caller then performs
   * a regular join).
   */
  resumeMember(participant: Participant, connection: RoomConnection): { previous: RoomConnection | null; resumed: boolean } {
    const previous = this.members.get(participant.id);
    if (!previous) return { previous: null, resumed: false };
    const previousConnection = previous.connection;
    if (!previousConnection.offline) {
      try {
        previousConnection.close(1000, 'replaced');
      } catch {
        /* already gone */
      }
    }
    this.clearTtl();
    this.members.set(participant.id, {
      participant: {
        ...participant,
        joinedAt: previous.participant.joinedAt,
        presence: 'online',
      },
      connection,
    });
    this.lastActivityAt = Date.now();
    this.emitMember('resumed', participant.id);
    return { previous: previousConnection, resumed: true };
  }

  /**
   * Keeps a participant in the room while their socket is gone: the live
   * connection is replaced by an offline placeholder and presence becomes
   * `reconnecting`. The signaling layer owns the grace timer and either resumes
   * the member or finalizes the departure (docs/call-continuity.md).
   */
  markReconnecting(
    participantId: string,
    meta: {
      resumeCapable?: boolean;
      resumeTokenHash?: string;
      resumeExpiresAt?: number;
      resumeTokenHashPrev?: string;
      resumeExpiresAtPrev?: number;
      seatReservedUntil?: number;
    } = {},
  ): boolean {
    const member = this.members.get(participantId);
    if (!member) return false;
    member.participant.presence = 'reconnecting';
    const hash = meta.resumeTokenHash ?? member.connection.resumeTokenHash;
    const expiry = meta.resumeExpiresAt ?? member.connection.resumeExpiresAt;
    const hashPrev = meta.resumeTokenHashPrev ?? member.connection.resumeTokenHashPrev;
    const expiryPrev = meta.resumeExpiresAtPrev ?? member.connection.resumeExpiresAtPrev;
    const seatReservedUntil = meta.seatReservedUntil ?? member.connection.seatReservedUntil;
    member.connection = offlineConnection({
      joinedAt: member.connection.joinedAt,
      ...(meta.resumeCapable ?? member.connection.resumeCapable ? { resumeCapable: true } : {}),
      ...(hash ? { resumeTokenHash: hash } : {}),
      ...(expiry ? { resumeExpiresAt: expiry } : {}),
      ...(hashPrev ? { resumeTokenHashPrev: hashPrev } : {}),
      ...(expiryPrev ? { resumeExpiresAtPrev: expiryPrev } : {}),
      ...(seatReservedUntil ? { seatReservedUntil } : {}),
      ...(member.connection.roleId ? { roleId: member.connection.roleId } : {}),
    });
    return true;
  }

  /**
   * Rebuilds the member map from a persisted snapshot (Core restart). Every
   * participant is offline until it resumes and no seat is reserved (see
   * {@link seatedParticipantCount}).
   */
  restoreMembers(
    entries: Array<{
      participant: Participant;
      joinedAt?: number;
      resumeCapable?: boolean;
      resumeTokenHash?: string;
      resumeExpiresAt?: number;
      resumeTokenHashPrev?: string;
      resumeExpiresAtPrev?: number;
    }>,
    lastActivityAt?: number,
  ): void {
    this.clearTtl();
    this.members.clear();
    for (const entry of entries) {
      const participant: Participant = { ...entry.participant, presence: 'reconnecting' };
      this.members.set(participant.id, {
        participant,
        connection: offlineConnection({
          joinedAt: entry.joinedAt ?? participant.joinedAt,
          ...(entry.resumeCapable ? { resumeCapable: true } : {}),
          ...(entry.resumeTokenHash ? { resumeTokenHash: entry.resumeTokenHash } : {}),
          ...(entry.resumeExpiresAt ? { resumeExpiresAt: entry.resumeExpiresAt } : {}),
          ...(entry.resumeTokenHashPrev ? { resumeTokenHashPrev: entry.resumeTokenHashPrev } : {}),
          ...(entry.resumeExpiresAtPrev ? { resumeExpiresAtPrev: entry.resumeExpiresAtPrev } : {}),
        }),
      });
    }
    if (typeof lastActivityAt === 'number' && Number.isFinite(lastActivityAt)) {
      this.lastActivityAt = Math.min(Date.now(), Math.max(this.createdAt, lastActivityAt));
    }
    if (this.members.size === 0) {
      const idleMs = Math.max(0, Date.now() - this.lastActivityAt);
      this.scheduleTtl(idleMs);
    }
  }

  removeMember(participantId: string): RoomMember | undefined {
    const member = this.members.get(participantId);
    if (!member) return undefined;
    this.members.delete(participantId);
    this.captions.delete(participantId);
    this.gpsLocations.delete(participantId);
    this.lastActivityAt = Date.now();
    this.emitMember('left', participantId);
    if (this.members.size === 0) this.scheduleTtl();
    return member;
  }

  private emitMember(type: 'joined' | 'left' | 'resumed', participantId: string): void {
    try {
      this.onMemberEvent?.(type, participantId);
    } catch {
      /* metering listeners must never break participant handling */
    }
  }

  /** Stores a consent-based GPS fix (coordinates never leave the server API). */
  setGpsLocation(participantId: string, location: GpsLocation): void {
    this.gpsLocations.set(participantId, location);
    this.lastActivityAt = Date.now();
  }

  gpsLocation(participantId: string): GpsLocation | undefined {
    return this.gpsLocations.get(participantId);
  }

  updateParticipant(participantId: string, patch: Partial<Pick<Participant, 'name' | 'role' | 'country' | 'permissions'>>): Participant | null {
    const member = this.members.get(participantId);
    if (!member) return null;
    if (patch.name) member.participant.name = patch.name;
    if (patch.role) member.participant.role = patch.role;
    if (patch.country) member.participant.country = patch.country;
    if (patch.permissions) member.participant.permissions = patch.permissions;
    return member.participant;
  }

  updateState(participantId: string, state: Partial<ParticipantState>): ParticipantState | null {
    const member = this.members.get(participantId);
    if (!member) return null;
    member.participant.state = { ...member.participant.state, ...state };
    return member.participant.state;
  }

  /**
   * Recomputes the screen-share presenter from participant state. Annotations
   * belong to one share: a new presenter or the end of a share wipes them.
   * Returns what changed so the signaling layer can broadcast/audit it.
   */
  syncScreenPresenter(): { presenterId: string | null; changed: boolean; cleared: boolean } {
    let presenter: string | null = null;
    for (const member of this.members.values()) {
      if (member.participant.state.screen) {
        presenter = member.participant.id;
        break;
      }
    }
    const result = this.annotations.setPresenter(presenter);
    return { presenterId: this.annotations.presenterId, ...result };
  }

  updateIntegrity(
    participantId: string,
    integrity: Participant['integrity'],
  ): Participant | null {
    const member = this.members.get(participantId);
    if (!member) return null;
    member.participant.integrity = integrity;
    return member.participant;
  }

  sendTo(participantId: string, message: ServerMessage): boolean {
    const member = this.members.get(participantId);
    if (!member) return false;
    try {
      member.connection.send(message);
      return true;
    } catch {
      return false;
    }
  }

  broadcast(message: ServerMessage, options: BroadcastOptions = {}): number {
    const roles = options.roles ? new Set(options.roles) : null;
    let delivered = 0;
    for (const [id, member] of this.members) {
      if (options.except && id === options.except) continue;
      if (roles && !roles.has(member.participant.role)) continue;
      try {
        member.connection.send(message);
        delivered += 1;
      } catch {
        /* broken socket: the signaling layer will clean it up on close */
      }
    }
    return delivered;
  }

  /** Closes every socket and marks the room closed. */
  close(reason = 'room_closed'): void {
    this.closedFlag = true;
    this.clearTtl();
    for (const member of [...this.members.values()]) {
      try {
        member.connection.send({ type: 'bye', reason });
      } catch {
      }
      try {
        member.connection.close(1000, reason);
      } catch {
      }
    }
    this.members.clear();
    this.captions.clear();
  }

  addMessage(message: ChatMessage): ChatMessage {
    this.messages.push(message);
    if (this.messages.length > MAX_CHAT_HISTORY) {
      this.messages.splice(0, this.messages.length - MAX_CHAT_HISTORY);
    }
    this.lastActivityAt = Date.now();
    return message;
  }

  history(limit = MAX_CHAT_HISTORY): ChatMessage[] {
    const safeLimit = Math.max(1, Math.min(MAX_CHAT_HISTORY, Math.trunc(limit) || MAX_CHAT_HISTORY));
    return this.messages.slice(-safeLimit);
  }

  addSegment(segment: TranscriptSegment): TranscriptSegment {
    this.segments.push(segment);
    if (this.segments.length > MAX_TRANSCRIPT_SEGMENTS) {
      this.segments.splice(0, this.segments.length - MAX_TRANSCRIPT_SEGMENTS);
    }
    this.lastActivityAt = Date.now();
    return segment;
  }

  finalSegments(): TranscriptSegment[] {
    return this.segments.filter((segment) => segment.isFinal);
  }

  /* ---------------------- transcript consent / retention ---------------------- */

  /** Records consent once per participant; repeat calls refresh `grantedAt`. */
  grantTranscriptConsent(participantId: string, by = participantId): TranscriptConsent {
    const consent: TranscriptConsent = { participantId, grantedAt: Date.now(), by };
    this.transcriptConsents.set(participantId, consent);
    this.lastActivityAt = Date.now();
    return consent;
  }

  revokeTranscriptConsent(participantId: string): boolean {
    return this.transcriptConsents.delete(participantId);
  }

  hasTranscriptConsent(participantId: string): boolean {
    return this.transcriptConsents.has(participantId);
  }

  transcriptConsent(participantId: string): TranscriptConsent | null {
    return this.transcriptConsents.get(participantId) ?? null;
  }

  /**
   * Drops segments older than `retentionSec`. `0` means "keep for the room
   * lifetime". Returns the number of removed segments.
   */
  pruneTranscript(retentionSec: number, now = Date.now()): number {
    if (!Number.isFinite(retentionSec) || retentionSec <= 0) return 0;
    const cutoff = now - retentionSec * 1000;
    const before = this.segments.length;
    for (let index = this.segments.length - 1; index >= 0; index -= 1) {
      const segment = this.segments[index];
      if (segment && segment.ts < cutoff) this.segments.splice(index, 1);
    }
    return before - this.segments.length;
  }

  /** Removes one participant's stored segments (consent withdrawal / erasure). */
  removeTranscriptSegments(participantId: string): number {
    const before = this.segments.length;
    for (let index = this.segments.length - 1; index >= 0; index -= 1) {
      const segment = this.segments[index];
      if (segment && segment.participantId === participantId) this.segments.splice(index, 1);
    }
    this.captions.delete(participantId);
    return before - this.segments.length;
  }

  /** Empties the room transcript (host/moderator purge). */
  clearTranscript(): number {
    const removed = this.segments.length;
    this.segments.length = 0;
    this.captions.clear();
    this.transcriptConsents.clear();
    return removed;
  }

  setCaption(caption: LiveCaption): void {
    this.captions.set(caption.participantId, caption);
  }

  captionsList(): LiveCaption[] {
    return [...this.captions.values()];
  }

  get findings(): ComplianceFinding[] {
    return this.analysisFindings.map(({ finding }) => finding);
  }

  get hasAnalysis(): boolean {
    return Boolean(this.report || this.notes || this.analysisFindings.length);
  }

  setAnalysis(input: { report: ComplianceReport; notes: MeetingNotes | null }): void {
    this.report = input.report;
    if (input.notes) this.notes = input.notes;
    this.analysisFindings.push(...input.report.findings.map((finding) => ({ finding, storedAt: input.report.createdAt })));
    if (this.analysisFindings.length > MAX_FINDINGS) this.analysisFindings.splice(0, this.analysisFindings.length - MAX_FINDINGS);
    this.analysisUpdatedAt = Date.now();
  }

  pruneAnalysis(retentionMin: number, now = Date.now()): void {
    const cutoff = now - retentionMin * 60_000;
    if (this.report && this.report.createdAt <= cutoff) this.report = null;
    if (this.notes && this.notes.createdAt <= cutoff) this.notes = null;
    if (this.analysisFindings.some(({ storedAt }) => storedAt <= cutoff)) {
      this.analysisFindings = this.analysisFindings.filter(({ storedAt }) => storedAt > cutoff);
    }
  }

  /* ------------------------------- lockout ------------------------------- */

  lockoutStatus(ipHash: string, now = Date.now()): LockoutStatus {
    const attempt = this.joinAttempts.get(ipHash);
    if (!attempt || attempt.lockedUntil <= now) return { locked: false, retryAfterMs: 0 };
    return { locked: true, retryAfterMs: attempt.lockedUntil - now };
  }

  registerFailure(ipHash: string, options: LockoutOptions): FailureResult {
    const now = options.now ?? Date.now();
    this.pruneJoinAttempts(now);
    const previous = this.joinAttempts.get(ipHash);
    const failures = (previous?.failures ?? 0) + 1;
    const lockoutMs = Math.max(0, options.lockoutSec) * 1000;
    const locked = options.lockoutSec > 0 && failures >= Math.max(1, options.maxAttempts);
    const lockedUntil = locked ? now + lockoutMs : (previous?.lockedUntil ?? 0);
    this.joinAttempts.set(ipHash, { failures, lockedUntil: lockedUntil > now ? lockedUntil : 0, lastAt: now });
    return { attempts: failures, locked, lockedUntil };
  }

  resetFailures(ipHash: string): void {
    this.joinAttempts.delete(ipHash);
  }

  private pruneJoinAttempts(now: number): void {
    if (this.joinAttempts.size < MAX_JOIN_ATTEMPT_KEYS) return;
    for (const [key, value] of this.joinAttempts) {
      if (value.lockedUntil <= now && now - value.lastAt > 3600_000) this.joinAttempts.delete(key);
    }
  }

  /* --------------------------------- TTL --------------------------------- */

  private scheduleTtl(idleMs = 0): void {
    this.clearTtl();
    if (this.ttlSec <= 0) return;
    this.ttlTimer = setTimeout(() => {
      this.ttlTimer = null;
      if (this.members.size === 0 && !this.closedFlag) this.onIdle?.();
    }, Math.max(0, this.ttlSec * 1000 - idleMs));
    this.ttlTimer.unref?.();
  }

  /** Set by the registry to actually remove the room when its TTL elapses. */
  onIdle?: () => void;

  private clearTtl(): void {
    if (!this.ttlTimer) return;
    clearTimeout(this.ttlTimer);
    this.ttlTimer = null;
  }

  dispose(): void {
    this.clearTtl();
    if (this.durationTimer) clearTimeout(this.durationTimer);
    this.durationTimer = null;
  }

  scheduleDurationDeadline(deadlineAt: number, now: number, expire: () => void): void {
    if (this.durationDeadlineAt !== undefined) return;
    this.durationDeadlineAt = deadlineAt;
    this.durationTimer = setTimeout(expire, Math.max(0, deadlineAt - now));
    this.durationTimer.unref?.();
  }
}

export interface RoomRegistryOptions {
  defaultTtlSec?: number;
  now?: () => number;
  maxDurationMs?: (room: Room) => number;
  onSfuRoomClose?: (room: Room) => Promise<void>;
  /** Lifecycle listener used by billing metering; failures are swallowed. */
  onRoomEvent?: (event: RoomLifecycleEvent) => void;
}

/** Input for {@link RoomRegistry.restore}: a room rebuilt from a snapshot. */
export interface RestoreRoomInput extends CreateRoomInput {
  durationDeadlineAt?: number;
  /** Offline members (no live socket) with their resume metadata. */
  participants?: Array<{
    participant: Participant;
    joinedAt?: number;
    resumeCapable?: boolean;
    resumeTokenHash?: string;
    resumeExpiresAt?: number;
  }>;
  /** Original last-activity timestamp (TTL honesty across a restart). */
  lastActivityAt?: number;
}

export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();
  private readonly now: () => number;
  private readonly defaultTtlSec: number;
  private readonly maxDurationMs?: (room: Room) => number;
  private readonly onSfuRoomClose?: (room: Room) => Promise<void>;
  private readonly pendingSfuCleanup = new Set<string>();
  private readonly onRoomEvent?: (event: RoomLifecycleEvent) => void;
  private createdTotal = 0;
  private readonly createdByTenant = new Map<string, number>();
  private readonly closeListeners = new Set<RoomCloseListener>();
  private readonly lifecycleListeners = new Set<(event: RoomLifecycleEvent) => void>();

  constructor(options: RoomRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.defaultTtlSec = Math.max(0, options.defaultTtlSec ?? 0);
    this.maxDurationMs = options.maxDurationMs;
    this.onSfuRoomClose = options.onSfuRoomClose;
    this.onRoomEvent = options.onRoomEvent;
  }

  get totalRoomsCreated(): number {
    return this.createdTotal;
  }

  roomsCreatedFor(tenantId: string): number {
    return this.createdByTenant.get(tenantId) ?? 0;
  }

  get size(): number {
    return this.rooms.size;
  }

  create(input: CreateRoomInput): Room {
    const id = input.id ?? randomUUID();
    if (!isValidRoomId(id)) throw new RoomRegistryError('invalid_room_id', `Invalid room id: ${id}`);
    if (this.rooms.has(id) || this.pendingSfuCleanup.has(id)) throw new RoomRegistryError('room_exists', `Room ${id} already exists`);
    const room = new Room({ ...input, id }, { ttlSec: this.defaultTtlSec, now: this.now });
    this.wireRoom(room);
    this.rooms.set(id, room);
    const parentDeadline = this.parentDurationDeadline(room);
    if (parentDeadline !== undefined) this.scheduleDurationDeadline(room, parentDeadline);
    this.createdTotal += 1;
    this.createdByTenant.set(room.tenantId, this.roomsCreatedFor(room.tenantId) + 1);
    this.emit({ type: 'created', room });
    return room;
  }

  /**
   * Rebuilds a room from a persisted snapshot after a Core restart.
   *
   * Unlike {@link create} it does not emit `created` (the room already existed
   * for metering/audit) and every participant is inserted offline with
   * `presence: 'reconnecting'` until their signaling socket resumes.
   */
  restore(input: RestoreRoomInput): Room {
    const id = input.id ?? randomUUID();
    if (!isValidRoomId(id)) throw new RoomRegistryError('invalid_room_id', `Invalid room id: ${id}`);
    if (this.rooms.has(id) || this.pendingSfuCleanup.has(id)) throw new RoomRegistryError('room_exists', `Room ${id} already exists`);
    const room = new Room({ ...input, id }, { ttlSec: this.defaultTtlSec, now: this.now });
    this.wireRoom(room);
    room.restoreMembers(input.participants ?? [], input.lastActivityAt);
    this.rooms.set(id, room);
    if (input.durationDeadlineAt !== undefined) this.scheduleDurationDeadline(room, input.durationDeadlineAt);
    this.emit({ type: 'restored', room });
    return room;
  }

  private wireRoom(room: Room): void {
    room.onIdle = () => this.close(room.id, 'ttl_expired');
    room.onMemberEvent = (type, participantId) => {
      if (type !== 'left' && room.durationDeadlineAt === undefined && this.maxDurationMs) {
        const parentDeadline = this.parentDurationDeadline(room);
        this.scheduleDurationDeadline(room, parentDeadline ?? this.now() + this.maxDurationMs(room));
      }
      if (type === 'joined') this.emit({ type: 'joined', room, participantId });
      else if (type === 'left') this.emit({ type: 'left', room, participantId });
      else this.emit({ type: 'resumed', room, participantId });
    };
  }

  private parentDurationDeadline(room: Room): number | undefined {
    return room.breakoutParentId ? this.rooms.get(room.breakoutParentId)?.durationDeadlineAt : undefined;
  }

  private scheduleDurationDeadline(room: Room, deadlineAt: number): void {
    room.scheduleDurationDeadline(deadlineAt, this.now(), () => this.close(room.id, 'duration_expired'));
  }

  get(id: string): Room | undefined {
    const room = this.rooms.get(id);
    if (!room || room.closed) return undefined;
    if (room.durationDeadlineAt !== undefined && room.durationDeadlineAt <= this.now()) {
      this.close(id, 'duration_expired');
      return undefined;
    }
    return room;
  }

  has(id: string): boolean {
    return this.get(id) !== undefined;
  }

  list(tenantId?: string): Room[] {
    return [...this.rooms.values()].filter((room) => !room.closed && (!tenantId || room.tenantId === tenantId));
  }

  /** All rooms matching a tenant, newest first. */
  listSorted(tenantId?: string): Room[] {
    return this.list(tenantId).sort((a, b) => b.createdAt - a.createdAt);
  }

  close(id: string, reason = 'room_closed'): boolean {
    const room = this.rooms.get(id);
    if (!room) return false;
    this.rooms.delete(id);
    const closeRemoteRoom = reason === 'duration_expired' || reason === 'admin_closed';
    const cleanup = closeRemoteRoom && room.mediaMode !== 'mesh' ? this.onSfuRoomClose : undefined;
    if (cleanup) {
      this.pendingSfuCleanup.add(id);
      void Promise.resolve().then(() => cleanup(room)).catch(() => undefined).finally(() => this.pendingSfuCleanup.delete(id));
    }
    room.close(reason);
    room.dispose();
    this.emit({ type: 'closed', room, reason });
    if (reason === 'duration_expired' && !room.breakoutParentId) {
      for (const child of this.rooms.values()) {
        if (child.breakoutParentId === id) this.close(child.id, reason);
      }
    }
    for (const listener of this.closeListeners) {
      try {
        listener(id);
      } catch {
        /* ignore listener errors */
      }
    }
    return true;
  }

  private emit(event: RoomLifecycleEvent): void {
    try {
      this.onRoomEvent?.(event);
    } catch {
      /* metering listeners must never break room lifecycle */
    }
    for (const listener of this.lifecycleListeners) {
      try {
        listener(event);
      } catch {
        /* continuity/persistence listeners are best-effort */
      }
    }
  }

  /** Subscribes to room lifecycle events (billing, continuity snapshots). */
  subscribe(listener: (event: RoomLifecycleEvent) => void): () => void {
    this.lifecycleListeners.add(listener);
    return () => {
      this.lifecycleListeners.delete(listener);
    };
  }

  onClose(listener: RoomCloseListener): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  /** Closes every room (graceful shutdown/tests). */
  clear(reason = 'server_shutdown'): void {
    for (const id of [...this.rooms.keys()]) this.close(id, reason);
  }

  totalParticipants(): number {
    let total = 0;
    for (const room of this.rooms.values()) total += room.participantCount;
    return total;
  }
}

/**
 * Effective config for one room: tenant config + optional per-room overrides
 * (validated when the room was created).
 */
export function roomConfig(room: Room, tenantConfig: TenantConfig): TenantConfig {
  if (!room.configOverrides) return tenantConfig;
  try {
    const config = resolveTenantConfig(room.configOverrides, tenantConfig, { tenantId: room.tenantId });
    if (tenantConfig.providers.recording.mode === 'disabled') config.providers.recording.mode = 'disabled';
    return config;
  } catch {
    return tenantConfig;
  }
}
