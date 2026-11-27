import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { compareFlows, flowSchema, type Flow } from '@agil/protocol';
import { z } from 'zod';
import { HttpError } from './http.js';
import type { LeaderElector } from './leader.js';

const TENANT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BOOTSTRAP = 'flows:bootstrap';
const READY = 'ready-v1';
const RETRIES = 8;
const manifestSchema = z.array(z.object({
  tenantId: z.string().regex(TENANT_ID),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
}));

type SharedStorage = Pick<LeaderElector, 'assertLeader' | 'readSharedValue' | 'leaderValue'>;
type FlowSnapshot = { version: 1; revision: number; flows: Flow[] };
type Change<T> = { value: T; flows?: Flow[]; beforeCommit?: () => Promise<void> };

interface FlowStoreOptions {
  dir: string;
  shared?: () => SharedStorage | null;
  fileLease?: () => Pick<LeaderElector, 'leaderValue'> | null;
  configuredTenants?: () => string[];
}

function emptySnapshot(): FlowSnapshot {
  return { version: 1, revision: 0, flows: [] };
}

function storageError(message: string): HttpError {
  return new HttpError(503, 'flow_storage_unavailable', message);
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function tenantKey(tenantId: string): string {
  return `flows:tenant:${hash(tenantId)}`;
}

function readSnapshot(raw: string, tenantId: string, mode: 'legacy' | 'migration' | 'shared'): FlowSnapshot {
  try {
    const legacy = mode !== 'shared';
    const data = JSON.parse(raw) as Partial<FlowSnapshot> | null;
    if (!data || !Array.isArray(data.flows) || (!legacy && data.version !== 1)) {
      throw new Error('Invalid flow snapshot');
    }
    const revision = data.revision ?? (legacy ? 0 : undefined);
    if (revision === undefined || !Number.isSafeInteger(revision) || revision < 0) {
      throw new Error('Invalid flow revision');
    }
    const flows: Flow[] = [];
    for (const candidate of data.flows) {
      const parsed = flowSchema.safeParse(candidate);
      if (parsed.success && parsed.data.tenantId === tenantId) flows.push(parsed.data);
      else if (mode !== 'legacy') throw new Error('Invalid shared flow');
    }
    return { version: 1, revision, flows };
  } catch {
    throw storageError('Could not read the flow configuration');
  }
}

/** One revisioned snapshot per tenant. The Redis backend never falls back to local files after migration. */
export class FlowStore {
  private readonly cache = new Map<string, FlowSnapshot>();
  private prepared: Promise<void> | null = null;

  constructor(private readonly options: FlowStoreOptions) {}

  clearCache(): void {
    this.cache.clear();
    this.prepared = null;
  }

  async list(tenantId: string): Promise<Flow[]> {
    const shared = await this.shared();
    const raw = shared ? await shared.readSharedValue(tenantKey(tenantId)) : null;
    const state = shared ? (raw === null ? emptySnapshot() : readSnapshot(raw, tenantId, 'shared')) : this.loadLocal(tenantId);
    return [...state.flows].sort(compareFlows);
  }

  async change<T>(tenantId: string, guard: () => void, apply: (current: Flow[]) => Change<T>): Promise<T> {
    guard();
    const shared = await this.shared();
    if (!shared && this.options.fileLease) {
      const lease = this.options.fileLease();
      if (!lease) throw storageError('Could not confirm authority to save the flow configuration');
      await lease.leaderValue('flows:file-fence');
    }
    const key = tenantKey(tenantId);
    for (let attempt = 0; attempt < RETRIES; attempt += 1) {
      guard();
      const raw = shared ? await shared.readSharedValue(key) : null;
      const state = shared ? (raw === null ? emptySnapshot() : readSnapshot(raw, tenantId, 'shared')) : this.loadLocal(tenantId);
      const result = apply(state.flows);
      if (!result.flows) return result.value;
      if (state.revision === Number.MAX_SAFE_INTEGER) throw storageError('Flow revision limit reached');
      if (result.beforeCommit) await result.beforeCommit();
      const next: FlowSnapshot = { version: 1, revision: state.revision + 1, flows: result.flows };
      guard();
      if (!shared) {
        this.persistLocal(tenantId, next);
        return result.value;
      }
      const saved = await shared.leaderValue(key, { expected: raw, next: JSON.stringify(next) });
      if (saved.changed) return result.value;
    }
    throw new HttpError(409, 'flow_write_conflict', 'The flow configuration changed concurrently');
  }

  tenantIds(): string[] {
    return this.options.shared ? this.options.configuredTenants?.() ?? [] : this.localTenantIds();
  }

  private async shared(): Promise<SharedStorage | null> {
    if (!this.options.shared) return null;
    const shared = this.options.shared();
    if (!shared) throw storageError('Shared flow storage is unavailable');
    if (!this.prepared) {
      const initializing = this.initialize(shared);
      this.prepared = initializing;
      void initializing.catch(() => {
        if (this.prepared === initializing) this.prepared = null;
      });
    }
    await this.prepared;
    return shared;
  }

  private async initialize(shared: SharedStorage): Promise<void> {
    let current = await shared.readSharedValue(BOOTSTRAP);
    if (current === READY) return;
    shared.assertLeader('shared flow migration');
    if (current === null) {
      const manifest = this.localTenantIds().map((tenantId) => ({
        tenantId, digest: hash(JSON.stringify(this.loadLocal(tenantId, false))),
      }));
      const claim = await shared.leaderValue(BOOTSTRAP, { expected: null, next: JSON.stringify(manifest) });
      current = claim.value;
      if (current === READY) return;
    }
    let manifest: z.infer<typeof manifestSchema>;
    try {
      manifest = manifestSchema.parse(JSON.parse(current ?? 'null'));
    } catch {
      throw storageError('Invalid shared flow migration state');
    }
    for (const { tenantId, digest } of manifest) {
      const key = tenantKey(tenantId);
      let existing = await shared.readSharedValue(key);
      if (existing === null) {
        const state = JSON.stringify(this.loadLocal(tenantId, false));
        if (hash(state) !== digest) throw storageError('Shared flow migration needs the original configuration files');
        existing = (await shared.leaderValue(key, { expected: null, next: state })).value;
      }
      if (existing === null || hash(existing) !== digest) throw storageError('Shared flow migration snapshot changed');
    }
    const committed = await shared.leaderValue(BOOTSTRAP, { expected: current, next: READY });
    if (committed.value !== READY) throw storageError('Shared flow migration could not finish');
  }

  private filePath(tenantId: string): string {
    const safe = TENANT_ID.test(tenantId) ? tenantId : hash(tenantId).slice(0, 16);
    return path.join(this.options.dir, `${safe}.json`);
  }

  private loadLocal(tenantId: string, useCache = true): FlowSnapshot {
    const cached = useCache ? this.cache.get(tenantId) : undefined;
    if (cached) return cached;
    let state: FlowSnapshot;
    try {
      state = readSnapshot(readFileSync(this.filePath(tenantId), 'utf8'), tenantId, useCache ? 'legacy' : 'migration');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw storageError('Could not read the flow configuration');
      state = emptySnapshot();
    }
    if (useCache) this.cache.set(tenantId, state);
    return state;
  }

  private localTenantIds(): string[] {
    try {
      return readdirSync(this.options.dir)
        .filter((file) => file.endsWith('.json'))
        .map((file) => file.slice(0, -'.json'.length))
        .filter((tenantId) => TENANT_ID.test(tenantId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw storageError('Could not list flow configuration files');
    }
  }

  private persistLocal(tenantId: string, state: FlowSnapshot): void {
    const file = this.filePath(tenantId);
    const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
    try {
      mkdirSync(this.options.dir, { recursive: true });
      writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      renameSync(tmp, file);
    } catch {
      try { rmSync(tmp, { force: true }); } catch { /* the previous snapshot is still authoritative */ }
      throw storageError('Could not save the flow configuration');
    }
    this.cache.set(tenantId, state);
  }
}
