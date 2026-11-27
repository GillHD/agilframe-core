import { createHash, createHmac, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { EgressError, type EgressStartInput, type EgressStartResult } from './egress.js';
import { HttpError } from './http.js';
import type { LeaderElector } from './leader.js';

const resultSchema = z.object({
  egressId: z.string().min(1), kind: z.enum(['recording', 'rtmp', 'hls']), status: z.string(), roomName: z.string().min(1),
}).strict();
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const recordSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('reserved'), fingerprint }).strict(),
  z.object({ state: z.literal('started'), fingerprint, result: resultSchema }).strict(),
]);
type LedgerRecord = z.infer<typeof recordSchema>;
type SharedLedger = Pick<LeaderElector, 'leaderValue'>;

export function egressIdempotencyKey(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[A-Za-z0-9._~-]{1,128}$/.test(value)) {
    throw new HttpError(400, 'invalid_idempotency_key', 'Idempotency-Key must contain 1 to 128 letters, digits, dots, underscores, tildes or hyphens');
  }
  return value;
}

function ledgerUnavailable(): HttpError {
  return new HttpError(503, 'egress_start_ledger_unavailable', 'Egress start state is unavailable. Retry using the same Idempotency-Key.');
}

function matches(existing: string, requested: string): void {
  if (existing !== requested) {
    throw new HttpError(409, 'idempotency_conflict', 'This Idempotency-Key is already associated with different Egress settings');
  }
}

function rejectedBeforeDispatch(error: unknown): boolean {
  return error instanceof EgressError && [
    'egress_disabled', 'egress_not_configured', 'egress_node_unavailable', 'validation_failed',
  ].includes(error.code);
}

/** Reserves the key durably before calling LiveKit. An abandoned reservation always blocks dispatch. */
export class EgressStartLedger {
  private readonly inFlight = new Map<string, { fingerprint: string; result: Promise<EgressStartResult> }>();

  constructor(private readonly dir: string, private readonly secret: string, private readonly shared?: SharedLedger) {}

  async start(key: string, input: EgressStartInput, launch: () => Promise<EgressStartResult>): Promise<EgressStartResult> {
    const id = createHash('sha256').update(JSON.stringify([input.tenantId, input.roomId, key])).digest('hex');
    const fingerprint = createHmac('sha256', this.secret).update(JSON.stringify([
      input.kind, input.layout ?? 'grid', Boolean(input.audioOnly), input.kind === 'rtmp' ? input.rtmpUrl ?? '' : '',
    ])).digest('hex');
    const existing = this.inFlight.get(id);
    if (existing) {
      matches(existing.fingerprint, fingerprint);
      return existing.result;
    }

    const result = this.execute(id, fingerprint, launch);
    this.inFlight.set(id, { fingerprint, result });
    try {
      return await result;
    } finally {
      this.inFlight.delete(id);
    }
  }

  private async execute(id: string, fingerprint: string, launch: () => Promise<EgressStartResult>): Promise<EgressStartResult> {
    const reservation = JSON.stringify({ state: 'reserved', fingerprint } satisfies LedgerRecord);
    if (!await this.change(id, null, reservation)) {
      const raw = await this.read(id);
      if (raw === null) throw ledgerUnavailable();
      let stored: LedgerRecord;
      try {
        stored = recordSchema.parse(JSON.parse(raw));
      } catch {
        throw ledgerUnavailable();
      }
      matches(stored.fingerprint, fingerprint);
      if (stored.state === 'started') return stored.result;
      throw new HttpError(409, 'egress_start_outcome_unknown', 'Egress may have started. Check existing jobs before starting another one.');
    }

    let result: EgressStartResult;
    try {
      result = await launch();
    } catch (error) {
      // Gateway errors, timeouts and incomplete replies can occur after LiveKit accepted the job.
      if (rejectedBeforeDispatch(error) && !await this.change(id, reservation, null)) throw ledgerUnavailable();
      throw error;
    }
    const saved = JSON.stringify({ state: 'started', fingerprint, result } satisfies LedgerRecord);
    if (!await this.change(id, reservation, saved)) throw ledgerUnavailable();
    return result;
  }

  private async read(id: string): Promise<string | null> {
    if (this.shared) return (await this.shared.leaderValue(`egress-start:${id}`)).value;
    return this.readFile(id);
  }

  private readFile(id: string): string | null {
    try {
      return readFileSync(path.join(this.dir, `${id}.json`), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw ledgerUnavailable();
    }
  }

  private async change(id: string, expected: string | null, next: string | null): Promise<boolean> {
    if (this.shared) return (await this.shared.leaderValue(`egress-start:${id}`, { expected, next })).changed;
    const file = path.join(this.dir, `${id}.json`);
    const temporary = path.join(this.dir, `${id}.${randomUUID()}.tmp`);
    try {
      // Only the caller that created a reservation can replace or release it.
      if (this.readFile(id) !== expected) return false;
      if (next === null) {
        unlinkSync(file);
      } else {
        mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        writeFileSync(temporary, next, { flag: 'wx', mode: 0o600, flush: true });
        if (expected === null) {
          // Publish a complete reservation without ever overwriting a competing start.
          try {
            linkSync(temporary, file);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
            throw error;
          }
        } else {
          renameSync(temporary, file);
        }
      }
      if (process.platform !== 'win32') {
        const directory = openSync(this.dir, 'r');
        try { fsyncSync(directory); } finally { closeSync(directory); }
      }
      return true;
    } catch {
      throw ledgerUnavailable();
    } finally {
      try { unlinkSync(temporary); } catch { /* It was renamed or never created. */ }
    }
  }
}
