/**
 * Billing / quota metering baseline.
 *
 * Responsibilities: persist per-tenant, per-month usage counters as JSON
 * (`<AGIL_DATA_DIR>/billing/<tenantId>/<YYYY-MM>.json`, atomic tmp+rename),
 * derive room minutes from room lifecycle events, resume a room session without
 * counting a second join, and evaluate plan quotas for room creation and
 * participant joins.
 *
 * Limits (documented in docs/billing.md): metering is in-process and single-node
 * with no ledger/aggregator; a call that spans a month boundary settles into the
 * month in which it ends; downtime between a Core restart and the first resumed
 * socket is not billed; no card data, invoices or payment provider exist here.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type {
  BillingConfig,
  BillingQuotaWarning,
  BillingUsageRecordDto,
} from '@agil/protocol';
import type { RoomLifecycleEvent, RoomRegistry } from './rooms.js';

export const BILLING_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
export const BILLING_WARNING_HEADER = 'x-agil-billing-warning';

const TENANT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

const usageRecordSchema = z.object({
  tenantId: z.string().min(1).max(64),
  month: z.string().regex(BILLING_MONTH_RE),
  minutes: z.number().min(0),
  roomsCreated: z.number().int().min(0),
  participantJoins: z.number().int().min(0),
  peakParticipants: z.number().int().min(0),
  recordings: z.number().int().min(0),
  recordingMinutes: z.number().min(0),
  createdAt: z.number().int().min(0),
  updatedAt: z.number().int().min(0),
});

export interface BillingLiveUsage {
  activeRooms: number;
  activeParticipants: number;
  liveMinutes: number;
  totalMinutes: number;
}

export interface BillingSnapshot {
  usage: BillingUsageRecordDto;
  live: BillingLiveUsage;
}

export interface BillingServiceOptions {
  /** Directory that holds `<tenantId>/<YYYY-MM>.json` files. */
  dir: string;
  now?: () => number;
}

interface ActiveSession {
  roomId: string;
  tenantId: string;
  startedAt: number;
  participants: Set<string>;
}

/** Months are UTC (`toISOString`), independent of the server timezone. */
export function billingMonth(at: number): string {
  return new Date(at).toISOString().slice(0, 7);
}

function roundMinutes(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function emptyUsage(tenantId: string, month: string, now: number): BillingUsageRecordDto {
  return {
    tenantId,
    month,
    minutes: 0,
    roomsCreated: 0,
    participantJoins: 0,
    peakParticipants: 0,
    recordings: 0,
    recordingMinutes: 0,
    createdAt: now,
    updatedAt: now,
  };
}

/** Monthly usage store + in-memory minute sessions. Safe against I/O failures. */
export class BillingService {
  private readonly dir: string;
  private readonly now: () => number;
  private readonly records = new Map<string, BillingUsageRecordDto>();
  private readonly sessions = new Map<string, ActiveSession>();

  constructor(options: BillingServiceOptions) {
    this.dir = options.dir;
    this.now = options.now ?? Date.now;
    try {
      mkdirSync(this.dir, { recursive: true });
    } catch {
      /* metering still works in memory when the directory is not writable */
    }
  }

  /** Current UTC month key (`YYYY-MM`). */
  currentMonth(): string {
    return billingMonth(this.now());
  }

  /** Persisted usage for a tenant/month (defaults to the current month). */
  getUsage(tenantId: string, month = this.currentMonth()): BillingUsageRecordDto {
    const key = `${tenantId}:${month}`;
    const cached = this.records.get(key);
    if (cached) return { ...cached };
    const loaded = this.load(tenantId, month) ?? emptyUsage(tenantId, month, this.now());
    this.records.set(key, loaded);
    return { ...loaded };
  }

  /** Usage + live (not-yet-settled) counters for the current month. */
  snapshot(tenantId: string, month = this.currentMonth()): BillingSnapshot {
    const usage = this.getUsage(tenantId, month);
    if (month !== this.currentMonth()) {
      return { usage, live: { activeRooms: 0, activeParticipants: 0, liveMinutes: 0, totalMinutes: usage.minutes } };
    }
    const liveMinutes = roundMinutes(this.liveMinutes(tenantId));
    const active = this.activeCounts(tenantId);
    return {
      usage,
      live: {
        activeRooms: active.rooms,
        activeParticipants: active.participants,
        liveMinutes,
        totalMinutes: roundMinutes(usage.minutes + liveMinutes),
      },
    };
  }

  /** Minutes elapsed in rooms that are currently occupied (not settled yet). */
  liveMinutes(tenantId: string): number {
    const now = this.now();
    let total = 0;
    for (const session of this.sessions.values()) {
      if (session.tenantId !== tenantId) continue;
      total += Math.max(0, now - session.startedAt) / 60_000;
    }
    return total;
  }

  /** Rooms/participants currently metered for a tenant. */
  activeCounts(tenantId: string): { rooms: number; participants: number } {
    let rooms = 0;
    let participants = 0;
    for (const session of this.sessions.values()) {
      if (session.tenantId !== tenantId) continue;
      rooms += 1;
      participants += session.participants.size;
    }
    return { rooms, participants };
  }

  /** Months with persisted usage for a tenant, newest first. */
  listMonths(tenantId: string): string[] {
    const safe = this.safeTenant(tenantId);
    try {
      return readdirSync(path.join(this.dir, safe))
        .filter((file) => file.endsWith('.json') && BILLING_MONTH_RE.test(file.slice(0, -'.json'.length)))
        .map((file) => file.slice(0, -'.json'.length))
        .sort()
        .reverse();
    } catch {
      return [];
    }
  }

  /** Applies room lifecycle events from the registry. Never throws. */
  observe(event: RoomLifecycleEvent): void {
    try {
      if (event.type === 'created') {
        this.recordRoomCreated(event.room.tenantId);
      } else if (event.type === 'joined') {
        this.recordParticipantJoin(event.room.tenantId, event.room.id, event.participantId);
      } else if (event.type === 'resumed') {
        // Continuity resume (grace lease or restored slot after a restart):
        // the participant never left, so this must not count as a new join.
        this.recordParticipantResume(event.room.tenantId, event.room.id, event.participantId);
      } else if (event.type === 'left') {
        this.recordParticipantLeave(event.room.id, event.participantId);
      } else if (event.type === 'closed') {
        this.recordRoomClosed(event.room.id);
      }
      // `restored` starts no session: a restored room may contain only offline
      // ghosts. Its meter reopens when the first participant resumes or a fresh
      // participant joins (no billing for the downtime).
    } catch {
      /* metering must never break the call path */
    }
  }

  recordRoomCreated(tenantId: string): void {
    const usage = this.getUsage(tenantId);
    usage.roomsCreated += 1;
    this.commit(tenantId, usage);
  }

  recordParticipantJoin(tenantId: string, roomId: string, participantId: string): void {
    const now = this.now();
    let session = this.sessions.get(roomId);
    if (!session) {
      session = { roomId, tenantId, startedAt: now, participants: new Set() };
      this.sessions.set(roomId, session);
    }
    // A duplicate socket (second connection for a participant that is already
    // metered, no resume token) replaces the transport but is not a new entry
    // into the call, so `participantJoins`/quotas must not be inflated.
    const alreadyMetered = session.participants.has(participantId);
    session.participants.add(participantId);
    const usage = this.getUsage(tenantId);
    if (!alreadyMetered) usage.participantJoins += 1;
    const active = this.activeCounts(tenantId);
    usage.peakParticipants = Math.max(usage.peakParticipants, active.participants);
    usage.updatedAt = now;
    this.commit(tenantId, usage);
  }

  /**
   * Continues metering for a resumed participant (grace lease or restored room).
   * A live process already has the session and the participant in it, so this is
   * a no-op; after a Core restart the session is reopened with `startedAt = now`,
   * so the resumed call is metered from the moment somebody is actually back. A
   * resume never increments `participantJoins`.
   */
  recordParticipantResume(tenantId: string, roomId: string, participantId: string): void {
    const now = this.now();
    let session = this.sessions.get(roomId);
    if (!session) {
      session = { roomId, tenantId, startedAt: now, participants: new Set() };
      this.sessions.set(roomId, session);
    } else if (session.participants.has(participantId)) {
      // Normal grace-window resume: the meter never stopped, nothing to write.
      return;
    }
    session.participants.add(participantId);
    const usage = this.getUsage(tenantId);
    const active = this.activeCounts(tenantId);
    usage.peakParticipants = Math.max(usage.peakParticipants, active.participants);
    usage.updatedAt = now;
    this.commit(tenantId, usage);
  }

  recordParticipantLeave(roomId: string, participantId: string): void {
    const session = this.sessions.get(roomId);
    if (!session) return;
    session.participants.delete(participantId);
    if (session.participants.size > 0) return;
    this.settle(session);
  }

  recordRoomClosed(roomId: string): void {
    const session = this.sessions.get(roomId);
    if (session) this.settle(session);
  }

  /** Counts one stored recording and its duration. */
  recordRecording(tenantId: string, durationSec: number): void {
    const usage = this.getUsage(tenantId);
    usage.recordings += 1;
    usage.recordingMinutes = roundMinutes(
      usage.recordingMinutes + Math.max(0, Number.isFinite(durationSec) ? durationSec : 0) / 60,
    );
    this.commit(tenantId, usage);
  }

  /** Test/ops helper: forget in-memory sessions without touching persisted usage. */
  resetSessions(): void {
    this.sessions.clear();
  }

  private settle(session: ActiveSession): void {
    const now = this.now();
    const elapsedMs = Math.max(0, now - session.startedAt);
    this.sessions.delete(session.roomId);
    if (elapsedMs <= 0) return;
    // A room that crossed a month boundary is counted in the month it ends.
    const usage = this.getUsage(session.tenantId);
    usage.minutes = roundMinutes(usage.minutes + elapsedMs / 60_000);
    usage.updatedAt = now;
    this.commit(session.tenantId, usage);
  }

  private commit(tenantId: string, usage: BillingUsageRecordDto): void {
    usage.updatedAt = this.now();
    this.records.set(`${tenantId}:${usage.month}`, usage);
    this.persist(tenantId, usage);
  }

  private safeTenant(tenantId: string): string {
    if (TENANT_ID_RE.test(tenantId)) return tenantId;
    return createHash('sha256').update(tenantId).digest('hex').slice(0, 16);
  }

  private dirFor(tenantId: string): string {
    return path.join(this.dir, this.safeTenant(tenantId));
  }

  private filePath(tenantId: string, month: string): string {
    return path.join(this.dirFor(tenantId), `${month}.json`);
  }

  private load(tenantId: string, month: string): BillingUsageRecordDto | null {
    const file = this.filePath(tenantId, month);
    if (!existsSync(file)) return null;
    try {
      const parsed = usageRecordSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
      if (!parsed.success) return null;
      return { ...parsed.data, tenantId, month };
    } catch {
      return null;
    }
  }

  private persist(tenantId: string, usage: BillingUsageRecordDto): void {
    try {
      const dir = this.dirFor(tenantId);
      mkdirSync(dir, { recursive: true });
      const file = this.filePath(tenantId, usage.month);
      const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
      writeFileSync(tmp, `${JSON.stringify(usage, null, 2)}\n`, 'utf8');
      try {
        renameSync(tmp, file);
      } catch {
        // Windows can refuse to replace an open file; retry after removing it.
        rmSync(file, { force: true });
        renameSync(tmp, file);
      }
    } catch {
      /* persistence is best-effort: the server keeps metering in memory */
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Quota evaluation                                                           */
/* -------------------------------------------------------------------------- */

export interface QuotaViolation {
  metric: BillingQuotaWarning['metric'];
  used: number;
  limit: number;
  message: string;
}

export interface QuotaDecision {
  allowed: boolean;
  /** Populated for `overagePolicy='warn'` (soft warning, operation allowed). */
  warnings: BillingQuotaWarning[];
  /** Populated for `overagePolicy='block'` (operation rejected). */
  blocked: BillingQuotaWarning | null;
  /** All exceeded quotas regardless of policy (for status/usage reporting). */
  violations: QuotaViolation[];
}

function toWarning(billing: BillingConfig, violation: QuotaViolation): BillingQuotaWarning {
  return {
    code: 'quota_warning',
    metric: violation.metric,
    used: violation.used,
    limit: violation.limit,
    policy: billing.overagePolicy,
    message: violation.message,
  };
}

function decide(billing: BillingConfig, violations: QuotaViolation[]): QuotaDecision {
  if (!billing.enabled || violations.length === 0) {
    return { allowed: true, warnings: [], blocked: null, violations: [] };
  }
  if (billing.overagePolicy === 'allow') {
    return { allowed: true, warnings: [], blocked: null, violations };
  }
  const warnings = violations.map((violation) => toWarning(billing, violation));
  if (billing.overagePolicy === 'block') {
    return { allowed: false, warnings: [], blocked: warnings[0] ?? null, violations };
  }
  return { allowed: true, warnings, blocked: null, violations };
}

function minutesViolation(billing: BillingConfig, totalMinutes: number): QuotaViolation | null {
  if (totalMinutes < billing.includedMinutes) return null;
  return {
    metric: 'minutes',
    used: roundMinutes(totalMinutes),
    limit: billing.includedMinutes,
    message: `Plan '${billing.plan}' minute quota exhausted: ${roundMinutes(totalMinutes)}/${billing.includedMinutes} included minutes used`,
  };
}

function roomsViolation(billing: BillingConfig, activeRooms: number): QuotaViolation | null {
  if (activeRooms < billing.maxRooms) return null;
  return {
    metric: 'rooms',
    used: activeRooms,
    limit: billing.maxRooms,
    message: `Plan '${billing.plan}' room quota reached: ${activeRooms}/${billing.maxRooms} concurrent rooms`,
  };
}

function participantsViolation(billing: BillingConfig, activeParticipants: number): QuotaViolation | null {
  if (activeParticipants < billing.maxParticipants) return null;
  return {
    metric: 'participants',
    used: activeParticipants,
    limit: billing.maxParticipants,
    message: `Plan '${billing.plan}' participant quota reached: ${activeParticipants}/${billing.maxParticipants} concurrent participants`,
  };
}

export interface RoomCreateQuotaInput {
  billing: BillingConfig;
  usage: Pick<BillingUsageRecordDto, 'minutes'>;
  liveMinutes: number;
  activeRooms: number;
}

/** Quota decision for `POST /v1/rooms` (and the admin room-create endpoint). */
export function evaluateRoomCreateQuota(input: RoomCreateQuotaInput): QuotaDecision {
  const totalMinutes = input.usage.minutes + input.liveMinutes;
  const violations = [minutesViolation(input.billing, totalMinutes), roomsViolation(input.billing, input.activeRooms)].filter(
    (violation): violation is QuotaViolation => violation !== null,
  );
  return decide(input.billing, violations);
}

export interface JoinQuotaInput {
  billing: BillingConfig;
  usage: Pick<BillingUsageRecordDto, 'minutes'>;
  liveMinutes: number;
  activeParticipants: number;
}

/** Quota decision for participant joins (REST join and WebSocket connect). */
export function evaluateJoinQuota(input: JoinQuotaInput): QuotaDecision {
  const totalMinutes = input.usage.minutes + input.liveMinutes;
  const violations = [
    minutesViolation(input.billing, totalMinutes),
    participantsViolation(input.billing, input.activeParticipants),
  ].filter((violation): violation is QuotaViolation => violation !== null);
  return decide(input.billing, violations);
}

/** Current rooms/participants of a tenant, straight from the room registry. */
export function tenantUsageCounts(registry: RoomRegistry, tenantId: string): { activeRooms: number; activeParticipants: number } {
  const rooms = registry.list(tenantId);
  let activeParticipants = 0;
  // Offline snapshots restored after a Core restart are not live participants:
  // they must not consume the tenant participant quota until they reconnect.
  for (const room of rooms) activeParticipants += room.seatedParticipantCount();
  return { activeRooms: rooms.length, activeParticipants };
}

/** Max participants for a new room under the plan (billing disabled = requested). */
export function planParticipantCap(billing: BillingConfig, requested: number): number {
  if (!billing.enabled) return requested;
  return Math.min(requested, billing.maxParticipants);
}

/** Quota warning currently worth surfacing for a tenant (warn policy only). */
export function currentQuotaWarnings(input: {
  billing: BillingConfig;
  usage: Pick<BillingUsageRecordDto, 'minutes'>;
  liveMinutes: number;
  activeRooms: number;
  activeParticipants: number;
}): BillingQuotaWarning[] {
  if (!input.billing.enabled || input.billing.overagePolicy !== 'warn') return [];
  const totalMinutes = input.usage.minutes + input.liveMinutes;
  const violations = [
    minutesViolation(input.billing, totalMinutes),
    roomsViolation(input.billing, input.activeRooms),
    participantsViolation(input.billing, input.activeParticipants),
  ].filter((violation): violation is QuotaViolation => violation !== null);
  return violations.map((violation) => toWarning(input.billing, violation));
}
