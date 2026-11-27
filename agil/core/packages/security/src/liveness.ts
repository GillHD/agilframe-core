/**
 * Liveness / anti-spoofing baseline (best-effort, NOT certified).
 *
 * What this actually does:
 *   - the server issues a random task (`blink`, `head-left`, `head-right`) bound
 *     to one tenant + room + participant, with a TTL and a bounded attempt count;
 *   - the browser runs MediaPipe Face Landmarker / OpenCV locally and reports
 *     only *signals* (booleans + confidence); video never leaves the device;
 *   - the engine checks that the reported signal matches the issued task.
 *
 * It does NOT prove that the person on camera is a live human rather than a
 * replayed/synthetic stream: client signals can be forged, and passive deepfake
 * detection is out of scope. See `docs/liveness-av.md`.
 *
 * Engines are pluggable ({@link LivenessEngine}): the built-in
 * {@link ChallengeLivenessEngine} runs the challenge in the browser, and
 * {@link HttpLivenessEngine} calls a **self-hosted** model service. With no
 * engine configured the feature is disabled (HTTP 501).
 */
import { randomInt, randomUUID } from 'node:crypto';
import { SecurityError } from './errors.js';

/**
 * Supported challenge tasks. Must stay in sync with `livenessTasks` in
 * `@agil/protocol`; the drift guard is `apps/server/test/liveness-av.test.ts`.
 */
export const LIVENESS_TASKS = ['blink', 'head-left', 'head-right'] as const;

export type LivenessTask = (typeof LIVENESS_TASKS)[number];

export type LivenessStatus = 'verified' | 'failed' | 'unavailable' | 'expired' | 'invalid';

/** Browser-reported evidence. Every field is optional; the server never trusts it as proof. */
export interface LivenessSignals {
  faceDetected?: boolean;
  blinkDetected?: boolean;
  headTurnDetected?: boolean;
  modelAvailable?: boolean;
  confidence?: number;
  framesAnalyzed?: number;
  durationMs?: number;
}

export interface LivenessChallengeInput {
  tenantId: string;
  roomId: string;
  participantId: string;
  /** Optional task preference (the server may ignore it to keep the challenge random). */
  task?: LivenessTask;
}

export interface LivenessIssueOptions {
  /** Challenge lifetime in seconds (clamped 30..600 by the service). */
  ttlSec: number;
}

/** Server-side session record (never contains browser media). */
export interface LivenessChallengeRecord {
  sessionId: string;
  tenantId: string;
  roomId: string;
  participantId: string;
  task: LivenessTask;
  issuedAt: number;
  expiresAt: number;
  attempts: number;
  maxAttempts: number;
  engine: string;
}

export interface LivenessVerdict {
  passed: boolean;
  status: LivenessStatus;
  /** Risk-style score 0..1 (0 = no concern, 1 = clearly failed). */
  score: number;
  flags: string[];
  engine: string;
  detail?: string;
}

/** Pluggable engine: issue a challenge and adjudicate its signals. */
export interface LivenessEngine {
  readonly name: string;
  isConfigured(): boolean;
  issue(
    input: LivenessChallengeInput,
    options: LivenessIssueOptions,
  ): Promise<Omit<LivenessChallengeRecord, 'attempts' | 'maxAttempts'>>;
  verify(input: { challenge: LivenessChallengeRecord; signals: LivenessSignals }): Promise<LivenessVerdict>;
}

const MIN_TTL_SEC = 30;
const MAX_TTL_SEC = 600;
const DEFAULT_TTL_SEC = 180;
const MIN_CONFIDENCE = 0.4;
const DEFAULT_MAX_ATTEMPTS = 2;
const MAX_MAX_ATTEMPTS = 10;
const DEFAULT_MAX_SESSIONS = 10_000;

function pickTask(preferred?: LivenessTask): LivenessTask {
  if (preferred && (LIVENESS_TASKS as readonly string[]).includes(preferred)) return preferred;
  return LIVENESS_TASKS[randomInt(LIVENESS_TASKS.length)] as LivenessTask;
}

function challengeFor(
  engine: string,
  input: LivenessChallengeInput,
  options: LivenessIssueOptions,
): Omit<LivenessChallengeRecord, 'attempts' | 'maxAttempts'> {
  const ttlSec = Number.isFinite(options?.ttlSec)
    ? Math.min(MAX_TTL_SEC, Math.max(MIN_TTL_SEC, Math.floor(options.ttlSec)))
    : DEFAULT_TTL_SEC;
  const issuedAt = Date.now();
  return {
    sessionId: randomUUID(),
    tenantId: input.tenantId,
    roomId: input.roomId,
    participantId: input.participantId,
    task: pickTask(input.task),
    issuedAt,
    expiresAt: issuedAt + ttlSec * 1000,
    engine,
  };
}

/** Strict consistency check of the reported task signal (client-side challenge). */
export class ChallengeLivenessEngine implements LivenessEngine {
  readonly name = 'challenge';

  isConfigured(): boolean {
    return true;
  }

  async issue(
    input: LivenessChallengeInput,
    options: LivenessIssueOptions,
  ): Promise<Omit<LivenessChallengeRecord, 'attempts' | 'maxAttempts'>> {
    return challengeFor(this.name, input, options);
  }

  async verify(input: { challenge: LivenessChallengeRecord; signals: LivenessSignals }): Promise<LivenessVerdict> {
    const { challenge, signals } = input;
    const signal = signals && typeof signals === 'object' ? signals : {};

    if (signal.modelAvailable === false) {
      // The browser could not load the face model: report "unknown", never accuse.
      return {
        passed: false,
        status: 'unavailable',
        score: 0.4,
        flags: ['liveness_model_unavailable'],
        engine: this.name,
        detail: 'face landmarker unavailable in the browser',
      };
    }
    if (signal.faceDetected === false) {
      return {
        passed: false,
        status: 'failed',
        score: 1,
        flags: ['no_face'],
        engine: this.name,
        detail: 'no face detected during the challenge',
      };
    }

    const observed = challenge.task === 'blink' ? signal.blinkDetected === true : signal.headTurnDetected === true;
    if (!observed) {
      return {
        passed: false,
        status: 'failed',
        score: 0.8,
        flags: ['liveness_signal_missing'],
        engine: this.name,
        detail: `challenge "${challenge.task}" was not observed`,
      };
    }

    const flags: string[] = [];
    if (typeof signal.confidence === 'number' && signal.confidence < MIN_CONFIDENCE) {
      // Low confidence does not fail the attempt (the model is noisy), it is
      // surfaced as evidence for a human reviewer.
      flags.push('low_confidence');
    }
    return { passed: true, status: 'verified', score: 0.1, flags, engine: this.name };
  }
}

export interface HttpLivenessEngineOptions {
  /** Self-hosted detector base URL, e.g. `http://liveness:8080`. Empty = disabled. */
  url?: string;
  /** Optional bearer token for the self-hosted service (never logged). */
  key?: string;
  /** Request timeout in milliseconds (default 5000). */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Adapter for a **self-hosted** anti-spoofing model (Silent-Face-Anti-Spoofing
 * / DeepFace): `POST ${url}/v1/liveness/verify` with `{session, signals}` and a
 * reply `{passed, score?, flags?, status?, detail?}`. Any HTTP/network failure
 * is reported as `status:'unavailable'`; the service applies the tenant's
 * fail-open/fail-closed policy.
 */
export class HttpLivenessEngine implements LivenessEngine {
  readonly name = 'external';
  private readonly url: string;
  private readonly key: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpLivenessEngineOptions = {}) {
    const source = options && typeof options === 'object' ? options : {};
    this.url = typeof source.url === 'string' ? source.url.trim().replace(/\/+$/, '') : '';
    this.key = typeof source.key === 'string' ? source.key.trim() : '';
    this.timeoutMs =
      Number.isFinite(source.timeoutMs) && (source.timeoutMs as number) > 0
        ? Math.min(60_000, Math.floor(source.timeoutMs as number))
        : 5000;
    this.fetchImpl = source.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  isConfigured(): boolean {
    return this.url.length > 0;
  }

  async issue(
    input: LivenessChallengeInput,
    options: LivenessIssueOptions,
  ): Promise<Omit<LivenessChallengeRecord, 'attempts' | 'maxAttempts'>> {
    return challengeFor(this.name, input, options);
  }

  async verify(input: { challenge: LivenessChallengeRecord; signals: LivenessSignals }): Promise<LivenessVerdict> {
    if (!this.isConfigured()) {
      return {
        passed: false,
        status: 'unavailable',
        score: 0.4,
        flags: ['liveness_engine_not_configured'],
        engine: this.name,
      };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
      if (this.key) headers.authorization = `Bearer ${this.key}`;
      const response = await this.fetchImpl(`${this.url}/v1/liveness/verify`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          session: {
            sessionId: input.challenge.sessionId,
            task: input.challenge.task,
            tenantId: input.challenge.tenantId,
            roomId: input.challenge.roomId,
            participantId: input.challenge.participantId,
            issuedAt: input.challenge.issuedAt,
            expiresAt: input.challenge.expiresAt,
          },
          signals: input.signals,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        return {
          passed: false,
          status: 'unavailable',
          score: 0.4,
          flags: ['liveness_engine_error'],
          engine: this.name,
          detail: `engine HTTP ${response.status}`,
        };
      }
      const payload = (await response.json()) as {
        passed?: unknown;
        status?: unknown;
        score?: unknown;
        flags?: unknown;
        detail?: unknown;
      };
      const passedClaim = payload?.passed === true;
      const declaredStatus: LivenessStatus | null =
        payload?.status === 'verified' || payload?.status === 'failed' || payload?.status === 'unavailable'
          ? payload.status
          : null;
      // The final status is authoritative; `passed` is normalised from it so a
      // malformed external reply (`{status:"verified",passed:false}`) can never
      // produce a contradictory verdict. Contradictions are surfaced as a flag
      // for the audit trail.
      const status: LivenessStatus = declaredStatus ?? (passedClaim ? 'verified' : 'failed');
      const passed = status === 'verified';
      const contradictory = declaredStatus !== null && payload?.passed !== undefined && passedClaim !== passed;
      const score =
        typeof payload?.score === 'number' && Number.isFinite(payload.score)
          ? Math.min(1, Math.max(0, payload.score))
          : passed
            ? 0.1
            : 0.8;
      const flags = Array.isArray(payload?.flags)
        ? payload.flags.filter((flag): flag is string => typeof flag === 'string').slice(0, 20)
        : [];
      if (contradictory) flags.push('liveness_engine_inconsistent_verdict');
      return {
        passed,
        status,
        score,
        flags,
        engine: this.name,
        ...(typeof payload?.detail === 'string' ? { detail: payload.detail.slice(0, 200) } : {}),
      };
    } catch (error) {
      return {
        passed: false,
        status: 'unavailable',
        score: 0.4,
        flags: ['liveness_engine_error'],
        engine: this.name,
        detail: (error instanceof Error ? error.message : 'engine request failed').slice(0, 200),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface LivenessSessionStoreOptions {
  /** Maximum live sessions (oldest-expiring dropped first); default 10000. */
  maxSessions?: number;
  now?: () => number;
}

/**
 * In-memory, tenant-scoped challenge sessions (single-use, TTL, bounded).
 * Sessions are intentionally not persisted: a liveness check is a moment-in-time
 * signal, and an expired process-local session is meaningless after a restart.
 */
export class LivenessSessionStore {
  private readonly sessions = new Map<string, LivenessChallengeRecord>();
  private readonly maxSessions: number;
  private readonly now: () => number;

  constructor(options: LivenessSessionStoreOptions = {}) {
    const source = options && typeof options === 'object' ? options : {};
    this.maxSessions =
      Number.isFinite(source.maxSessions) && (source.maxSessions as number) > 0
        ? Math.floor(source.maxSessions as number)
        : DEFAULT_MAX_SESSIONS;
    this.now = source.now ?? Date.now;
  }

  private key(tenantId: string, sessionId: string): string {
    return `${tenantId}:${sessionId}`;
  }

  create(challenge: LivenessChallengeRecord): LivenessChallengeRecord {
    this.sweep();
    if (this.sessions.size >= this.maxSessions) {
      // Drop the session that expires soonest: bounded memory, no timers.
      let oldestKey: string | null = null;
      let oldestExpiry = Number.POSITIVE_INFINITY;
      for (const [key, record] of this.sessions) {
        if (record.expiresAt < oldestExpiry) {
          oldestExpiry = record.expiresAt;
          oldestKey = key;
        }
      }
      if (oldestKey) this.sessions.delete(oldestKey);
    }
    this.sessions.set(this.key(challenge.tenantId, challenge.sessionId), challenge);
    return challenge;
  }

  /** Tenant-scoped lookup; null for unknown, foreign-tenant or expired sessions. */
  get(tenantId: string, sessionId: string): LivenessChallengeRecord | null {
    const record = this.sessions.get(this.key(tenantId, sessionId)) ?? null;
    if (!record) return null;
    if (record.expiresAt <= this.now()) {
      this.sessions.delete(this.key(tenantId, sessionId));
      return null;
    }
    return record;
  }

  /** Increments the attempt counter and returns the updated record. */
  beginAttempt(tenantId: string, sessionId: string): LivenessChallengeRecord | null {
    const record = this.get(tenantId, sessionId);
    if (!record) return null;
    record.attempts += 1;
    return record;
  }

  /** Removes a consumed session (verified or exhausted). */
  consume(tenantId: string, sessionId: string): void {
    this.sessions.delete(this.key(tenantId, sessionId));
  }

  /** Drops expired sessions; returns the number removed. */
  sweep(): number {
    const now = this.now();
    let removed = 0;
    for (const [key, record] of this.sessions) {
      if (record.expiresAt <= now) {
        this.sessions.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  get size(): number {
    return this.sessions.size;
  }
}

export type LivenessEngineErrorPolicy = 'fail-open' | 'fail-closed';

export interface LivenessServicePolicy {
  ttlSec: number;
  maxAttempts: number;
  /** `fail-open` = engine errors/timeouts become `unavailable` (never accused). */
  onEngineError: LivenessEngineErrorPolicy;
}

export interface LivenessServiceOptions {
  engine?: LivenessEngine;
  store?: LivenessSessionStore;
  policy?: Partial<LivenessServicePolicy>;
  now?: () => number;
}

export interface LivenessVerifyInput {
  tenantId: string;
  roomId: string;
  participantId: string;
  sessionId: string;
  signals: LivenessSignals;
}

export interface LivenessVerifyResult extends LivenessVerdict {
  sessionId: string;
  attempts: number;
  maxAttempts: number;
}

/**
 * Orchestrates challenge issuance + verification with explicit failure policy.
 * Throws `SecurityError('liveness_not_configured')` when no engine is available.
 */
export class LivenessService {
  readonly engine?: LivenessEngine;
  private readonly store: LivenessSessionStore;
  private readonly policy: LivenessServicePolicy;
  private readonly now: () => number;

  constructor(options: LivenessServiceOptions = {}) {
    const source = options && typeof options === 'object' ? options : {};
    this.engine = source.engine;
    this.store = source.store ?? new LivenessSessionStore();
    const ttlSec = Number.isFinite(source.policy?.ttlSec) ? Math.floor(source.policy?.ttlSec as number) : DEFAULT_TTL_SEC;
    const maxAttempts = Number.isFinite(source.policy?.maxAttempts)
      ? Math.floor(source.policy?.maxAttempts as number)
      : DEFAULT_MAX_ATTEMPTS;
    this.policy = {
      ttlSec: Math.min(MAX_TTL_SEC, Math.max(MIN_TTL_SEC, ttlSec)),
      maxAttempts: Math.min(MAX_MAX_ATTEMPTS, Math.max(1, maxAttempts)),
      onEngineError: source.policy?.onEngineError === 'fail-closed' ? 'fail-closed' : 'fail-open',
    };
    this.now = source.now ?? Date.now;
  }

  /** True when an engine is configured; the tenant flag still has to be on. */
  isEnabled(): boolean {
    return Boolean(this.engine?.isConfigured());
  }

  get engineName(): string | null {
    return this.engine?.isConfigured() ? this.engine.name : null;
  }

  get policyValues(): LivenessServicePolicy {
    return { ...this.policy };
  }

  /** Issues a challenge owned by `tenantId` + `roomId` + `participantId`. */
  async issue(input: LivenessChallengeInput): Promise<LivenessChallengeRecord> {
    if (!this.engine?.isConfigured()) {
      throw new SecurityError(
        'liveness_not_configured',
        'Liveness is not configured (AGIL_LIVENESS_ENGINE / AGIL_LIVENESS_URL)',
      );
    }
    const challenge = await this.engine.issue(input, { ttlSec: this.policy.ttlSec });
    return this.store.create({ ...challenge, attempts: 0, maxAttempts: this.policy.maxAttempts });
  }

  /**
   * Verifies one attempt. Tenant/room/participant mismatches are rejected as
   * `invalid` without consuming another tenant's session. `options.onEngineError`
   * overrides the service default (the server passes the tenant's policy).
   */
  async verify(
    input: LivenessVerifyInput,
    options: { onEngineError?: LivenessEngineErrorPolicy } = {},
  ): Promise<LivenessVerifyResult> {
    if (!this.engine?.isConfigured()) {
      throw new SecurityError(
        'liveness_not_configured',
        'Liveness is not configured (AGIL_LIVENESS_ENGINE / AGIL_LIVENESS_URL)',
      );
    }
    const invalid = (flags: string[], detail: string): LivenessVerifyResult => ({
      sessionId: input.sessionId,
      passed: false,
      status: 'invalid',
      score: 0,
      flags,
      engine: this.engineName ?? 'none',
      detail,
      attempts: 0,
      maxAttempts: this.policy.maxAttempts,
    });

    const existing = this.store.get(input.tenantId, input.sessionId);
    if (!existing) {
      return invalid(['liveness_session_unknown'], 'unknown or expired liveness session');
    }
    if (existing.roomId !== input.roomId || existing.participantId !== input.participantId) {
      return invalid(['liveness_session_mismatch'], 'session does not belong to this room/participant');
    }
    if (existing.attempts >= existing.maxAttempts) {
      this.store.consume(input.tenantId, input.sessionId);
      return { ...invalid(['liveness_attempts_exhausted'], 'attempt limit reached'), status: 'expired' };
    }

    const challenge = this.store.beginAttempt(input.tenantId, input.sessionId) as LivenessChallengeRecord;
    let verdict: LivenessVerdict;
    try {
      verdict = await this.engine.verify({ challenge, signals: input.signals ?? {} });
    } catch (error) {
      verdict = {
        passed: false,
        status: 'unavailable',
        score: 0.4,
        flags: ['liveness_engine_error'],
        engine: this.engineName ?? 'none',
        detail: (error instanceof Error ? error.message : 'engine failed').slice(0, 200),
      };
    }

    if (verdict.status === 'unavailable' && (options.onEngineError ?? this.policy.onEngineError) === 'fail-closed') {
      verdict = {
        ...verdict,
        status: 'failed',
        passed: false,
        flags: [...new Set([...verdict.flags, 'liveness_engine_unavailable_fail_closed'])],
      };
    }

    if (verdict.status === 'verified') {
      this.store.consume(input.tenantId, input.sessionId);
    } else if (challenge.attempts >= challenge.maxAttempts) {
      // No retries left: drop the session so a stale id cannot be retried later.
      this.store.consume(input.tenantId, input.sessionId);
    }

    return {
      ...verdict,
      // Keep the boolean and the status consistent for every engine: callers
      // (and the HTTP endpoint) use `status`, so `passed` must never contradict
      // it. `verified` is the only passing status.
      passed: verdict.status === 'verified',
      sessionId: input.sessionId,
      attempts: challenge.attempts,
      maxAttempts: challenge.maxAttempts,
    };
  }

  /** Drops expired sessions; safe to call periodically (no internal timer). */
  sweep(): number {
    return this.store.sweep();
  }

  get sessionCount(): number {
    return this.store.size;
  }

  /** Exposed for tests/diagnostics. */
  get sessionStore(): LivenessSessionStore {
    return this.store;
  }

  nowMs(): number {
    return this.now();
  }
}
