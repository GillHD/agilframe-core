/**
 * Tenant configuration store: in-memory cache + JSON persistence under
 * `<AGIL_DATA_DIR>/tenants/<tenantId>.json` (atomic tmp+rename writes).
 *
 * Unknown tenants always resolve to {@link defaultConfig}; reads never throw.
 * Every successful write notifies subscribers (the signaling layer broadcasts
 * `{type:'config'}` to the WebSockets of that tenant).
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  defaultConfig,
  DEFAULT_BRANDING,
  resolveTenantConfig,
  tenantConfigPatchSchema,
  tenantConfigSchema,
  type TenantConfig,
} from '@agil/protocol';

export interface ConfigIssue {
  path: string;
  message: string;
}

/** Raised for invalid tenant configs; the HTTP layer turns it into a 400. */
export class ConfigValidationError extends Error {
  readonly issues: ConfigIssue[];
  constructor(issues: ConfigIssue[]) {
    super('invalid_config');
    this.name = 'ConfigValidationError';
    this.issues = issues;
  }
}

export interface TenantEntry {
  config: TenantConfig;
  etag: string;
  updatedAt: number;
}

export interface TenantStoreOptions {
  dir: string;
  /** Tenants that exist implicitly (API keys, demo tenant) even without a file. */
  initialTenants?: string[];
  /** Optional validator run before a config is cached/persisted (e.g. SSRF URL policy). */
  validateConfig?: (config: TenantConfig) => void;
  now?: () => number;
}

type ConfigListener = (config: TenantConfig, tenantId: string) => void;

function etagOf(config: TenantConfig): string {
  return createHash('sha256').update(JSON.stringify(config)).digest('hex');
}

function issuesFromZod(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): ConfigIssue[] {
  return error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message }));
}

function isTenantId(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value);
}

export class TenantStore {
  private readonly dir: string;
  private readonly now: () => number;
  private readonly validateConfig?: (config: TenantConfig) => void;
  private readonly cache = new Map<string, TenantEntry>();
  private readonly known = new Set<string>();
  private readonly previouslyArchived = new Set<string>();
  private readonly listeners = new Map<string, Set<ConfigListener>>();
  private readonly globalListeners = new Set<ConfigListener>();

  constructor(options: TenantStoreOptions) {
    this.dir = options.dir;
    this.now = options.now ?? Date.now;
    this.validateConfig = options.validateConfig;
    try {
      mkdirSync(this.dir, { recursive: true });
    } catch {
      /* the store still works in memory when the directory is not writable */
    }
    for (const tenantId of options.initialTenants ?? []) this.known.add(tenantId);
    const archiveDir = path.join(this.dir, '.archive');
    if (existsSync(archiveDir)) {
      for (const filename of readdirSync(archiveDir)) {
        const id = /^(.*)-\d+\.json$/.exec(filename)?.[1];
        if (id && isTenantId(id) && !this.known.has(id) && !existsSync(this.filePath(id))) {
          this.previouslyArchived.add(id);
        }
      }
    }
  }

  isRetired(tenantId: string): boolean {
    return isTenantId(tenantId) && (
      this.previouslyArchived.has(tenantId) || existsSync(this.retiredPath(tenantId))
    );
  }

  /** Tenant ids known to this server (persisted files + API keys + demo tenant). */
  listTenants(): string[] {
    const ids = new Set(this.known);
    for (const tenantId of this.cache.keys()) ids.add(tenantId);
    try {
      for (const file of readdirSync(this.dir)) {
        if (!file.endsWith('.json')) continue;
        const tenantId = file.slice(0, -'.json'.length);
        if (isTenantId(tenantId)) ids.add(tenantId);
      }
    } catch {
      /* directory may not exist in read-only environments */
    }
    return [...ids].filter((tenantId) => !this.isRetired(tenantId)).sort();
  }

  /** Full config for a tenant; unknown tenants get a validated default config. */
  getConfig(tenantId: string): TenantConfig {
    return this.getEntry(tenantId).config;
  }

  /** Reads a config without creating/defaulting a tenant (no resume side effects). */
  peekConfig(tenantId: string): TenantConfig | null {
    const cached = this.cache.get(tenantId);
    if (cached) return cached.config;
    const loaded = this.loadFromDisk(tenantId);
    return loaded ? { ...loaded, tenantId } : null;
  }

  getEtag(tenantId: string): string {
    return this.getEntry(tenantId).etag;
  }

  getEntry(tenantId: string): TenantEntry {
    const cached = this.cache.get(tenantId);
    if (cached) return cached;
    const loaded = this.loadFromDisk(tenantId);
    const config = loaded ?? defaultConfig({ tenantId });
    const entry: TenantEntry = {
      config,
      etag: etagOf(config),
      updatedAt: this.now(),
    };
    this.cache.set(tenantId, entry);
    this.known.add(tenantId);
    return entry;
  }

  /** Validates and stores a complete config. Throws {@link ConfigValidationError}. */
  putConfig(tenantId: string, input: unknown): TenantEntry {
    const parsed = tenantConfigSchema.safeParse({ ...(input as object), tenantId });
    if (!parsed.success) throw new ConfigValidationError(issuesFromZod(parsed.error));
    return this.commit(tenantId, parsed.data);
  }

  /**
   * Archives the config and reserves the ID on disk before the SaaS layer
   * closes rooms and withdraws the key. Returns whether a config file existed.
   */
  remove(tenantId: string): boolean {
    if (!isTenantId(tenantId)) return false;
    const file = this.filePath(tenantId);
    const target = this.retiredPath(tenantId);
    mkdirSync(path.dirname(target), { recursive: true });
    const existed = existsSync(file);
    if (existed) renameSync(file, target);
    else writeFileSync(target, '{}', { flag: 'wx' });
    this.cache.delete(tenantId);
    this.known.delete(tenantId);
    return existed;
  }

  private retiredPath(tenantId: string): string {
    return path.join(this.dir, '.archive', 'retired', `${tenantId}.json`);
  }

  /**
   * Applies a deep-partial patch on top of the current config (the tenantId in
   * the path always wins). Throws {@link ConfigValidationError}.
   */
  patchConfig(tenantId: string, input: unknown, options: { editorDraft?: boolean } = {}): TenantEntry {
    const parsed = (options.editorDraft ? tenantConfigSchema : tenantConfigPatchSchema).safeParse(input);
    if (!parsed.success) throw new ConfigValidationError(issuesFromZod(parsed.error));
    const current = this.getConfig(tenantId);
    let patch = { ...parsed.data, tenantId };
    let base = current;
    if (options.editorDraft) {
      const { customDomain: _customDomain, ...branding } = patch.branding ?? {};
      const { galleryVideoBudget: _galleryVideoBudget, ...limits } = current.limits;
      const { maxVisibleVideos: _maxVisibleVideos, ...scale } = current.scale;
      patch = { ...patch, branding };
      // A complete draft can also remove optional gallery budget overrides.
      base = {
        ...current,
        limits,
        scale,
        branding: { ...current.branding, mascotExpressions: {} },
        security: {
          ...current.security,
          accessPolicy: { ...current.security.accessPolicy, userOverrides: {} },
        },
      };
    }
    let config: TenantConfig;
    try {
      config = resolveTenantConfig(patch, base, { tenantId });
    } catch (error) {
      // resolveTenantConfig re-validates the merged config; surface zod details.
      const issues = (error as { issues?: Array<{ path: Array<string | number>; message: string }> }).issues;
      if (issues) throw new ConfigValidationError(issuesFromZod({ issues }));
      throw new ConfigValidationError([{ path: '', message: (error as Error).message }]);
    }
    config.tenantId = tenantId;
    return this.commit(tenantId, config, options.editorDraft);
  }

  /** Replaces the in-memory config without persisting (used by tests/seed). */
  setConfig(tenantId: string, config: TenantConfig): TenantEntry {
    const entry: TenantEntry = { config, etag: etagOf(config), updatedAt: this.now() };
    this.cache.set(tenantId, entry);
    this.known.add(tenantId);
    return entry;
  }

  /** Subscribes to config updates for one tenant; returns an unsubscribe function. */
  subscribe(tenantId: string, listener: ConfigListener): () => void {
    let set = this.listeners.get(tenantId);
    if (!set) {
      set = new Set();
      this.listeners.set(tenantId, set);
    }
    set.add(listener);
    return () => {
      const current = this.listeners.get(tenantId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.listeners.delete(tenantId);
    };
  }

  /**
   * Subscribes to every tenant's config updates (used to keep the custom-domain
   * registry in sync with `branding.customDomain`). Returns an unsubscribe.
   */
  subscribeAll(listener: ConfigListener): () => void {
    this.globalListeners.add(listener);
    return () => this.globalListeners.delete(listener);
  }

  private commit(tenantId: string, config: TenantConfig, requirePersistence = false): TenantEntry {
    if (this.isRetired(tenantId)) {
      throw new ConfigValidationError([{ path: 'tenantId', message: 'Tenant has been retired' }]);
    }
    // Fail before persisting: an invalid outbound endpoint must never be saved.
    this.validateConfig?.(config);
    const entry: TenantEntry = { config, etag: etagOf(config), updatedAt: this.now() };
    if (requirePersistence) this.persist(tenantId, config, true);
    this.cache.set(tenantId, entry);
    this.known.add(tenantId);
    if (!requirePersistence) this.persist(tenantId, config);
    this.emit(tenantId, config);
    return entry;
  }

  private emit(tenantId: string, config: TenantConfig): void {
    const listeners = [
      ...(this.listeners.get(tenantId) ?? []),
      ...this.globalListeners,
    ];
    for (const listener of listeners) {
      try {
        listener(config, tenantId);
      } catch {
        /* a broken subscriber must never break a config write */
      }
    }
  }

  private filePath(tenantId: string): string {
    // Tenant ids are validated on write; sanitise defensively for reads too.
    const safe = isTenantId(tenantId) ? tenantId : createHash('sha256').update(tenantId).digest('hex').slice(0, 16);
    return path.join(this.dir, `${safe}.json`);
  }

  private loadFromDisk(tenantId: string): TenantConfig | null {
    const file = this.filePath(tenantId);
    try {
      const raw = readFileSync(file, 'utf8');
      const parsed = tenantConfigSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) return null;
      if (parsed.data.branding.productName === 'AGIL Calls') {
        parsed.data.branding.productName = DEFAULT_BRANDING.productName;
      }
      return { ...parsed.data, tenantId };
    } catch {
      return null;
    }
  }

  /** Atomic write: serialise, write `<file>.tmp-<rand>`, fsync-less rename. */
  private persist(tenantId: string, config: TenantConfig, required = false): void {
    const file = this.filePath(tenantId);
    const tmp = `${file}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
      try {
        renameSync(tmp, file);
      } catch (error) {
        if (required) throw error;
        // Windows can refuse to replace an open file; retry after removing it.
        rmSync(file, { force: true });
        renameSync(tmp, file);
      }
    } catch (error) {
      if (required) {
        try { rmSync(tmp, { force: true }); } catch { /* preserve the write error */ }
        throw error;
      }
      /* persistence is best-effort: the server keeps serving from memory */
    }
  }
}
