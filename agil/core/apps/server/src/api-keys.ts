/**
 * Dynamic tenant API keys (SaaS onboarding, `AGIL_PLATFORM_KEY` feature).
 *
 * Env keys (`AGIL_API_KEYS`) stay the root credentials. Keys generated through
 * the platform API are stored **hashed** in `AGIL_DATA_DIR/api-keys.json`
 * (sha256 of `ipSalt:key`, constant-time compare) and never returned again.
 * Rotating a tenant key replaces its previous dynamic key; env keys cannot be
 * revoked by the API.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Env } from './env.js';

interface StoredKey {
  tenantId: string;
  hash: string;
  createdAt: number;
  label?: string;
}

interface KeyFile {
  version: 1;
  keys: StoredKey[];
}

function hashKey(env: Env, raw: string): string {
  return createHash('sha256').update(`${env.ipSalt}:${raw}`, 'utf8').digest('hex');
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

class ApiKeyStore {
  private readonly env: Env;
  private readonly file: string;
  private keys: StoredKey[];

  constructor(env: Env) {
    this.env = env;
    this.file = path.join(env.dataDir, 'api-keys.json');
    this.keys = this.load();
  }

  private load(): StoredKey[] {
    try {
      if (!existsSync(this.file)) return [];
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<KeyFile>;
      if (!Array.isArray(parsed.keys)) return [];
      return parsed.keys.filter(
        (entry): entry is StoredKey =>
          Boolean(entry) &&
          typeof entry.tenantId === 'string' &&
          typeof entry.hash === 'string' &&
          /^[0-9a-f]{64}$/.test(entry.hash),
      );
    } catch {
      return [];
    }
  }

  private persist(): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const data: KeyFile = { version: 1, keys: this.keys };
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    renameSync(tmp, this.file);
  }

  /** Returns the tenant this dynamic key belongs to (null for unknown/revoked). */
  resolve(raw: string): string | null {
    if (!raw) return null;
    const hash = hashKey(this.env, raw);
    for (const entry of this.keys) {
      if (safeEqual(entry.hash, hash)) return entry.tenantId;
    }
    return null;
  }

  /** True when a dynamic or env key exists for this tenant (value never exposed). */
  has(tenantId: string): boolean {
    if (Object.values(this.env.apiKeys).includes(tenantId)) return true;
    return this.keys.some((entry) => entry.tenantId === tenantId);
  }

  tenantIds(): string[] {
    return [...new Set(this.keys.map((entry) => entry.tenantId))];
  }

  createdAt(tenantId: string): number | undefined {
    const entry = this.keys.find((key) => key.tenantId === tenantId);
    return entry?.createdAt;
  }

  /** Issues a new key, invalidating the tenant's previous dynamic key. */
  issue(tenantId: string): { apiKey: string; createdAt: number } {
    const apiKey = `agil_${tenantId.slice(0, 12)}_${randomBytes(24).toString('base64url')}`;
    const createdAt = Date.now();
    this.keys = this.keys.filter((entry) => entry.tenantId !== tenantId);
    this.keys.push({ tenantId, hash: hashKey(this.env, apiKey), createdAt });
    this.persist();
    return { apiKey, createdAt };
  }

  removeTenant(tenantId: string): void {
    const before = this.keys.length;
    this.keys = this.keys.filter((entry) => entry.tenantId !== tenantId);
    if (this.keys.length !== before) this.persist();
  }
}

const stores = new Map<string, ApiKeyStore>();

/** One store per data directory (tests spawn many ephemeral servers). */
export function apiKeyStore(env: Env): ApiKeyStore {
  const cacheKey = path.resolve(env.dataDir);
  const existing = stores.get(cacheKey);
  if (existing) return existing;
  const store = new ApiKeyStore(env);
  stores.set(cacheKey, store);
  return store;
}

export function resolveTenantApiKey(env: Env, key: string): string | null {
  if (!key || (env.platformKey && key === env.platformKey)) return null;
  if (!Object.hasOwn(env.apiKeys, key)) return apiKeyStore(env).resolve(key);
  const tenantId: unknown = env.apiKeys[key];
  return typeof tenantId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(tenantId) ? tenantId : null;
}

/** Generates a fresh high-entropy tenant API key (plaintext returned once). */
export function generateTenantApiKey(tenantId: string): string {
  return `agil_${tenantId.slice(0, 12)}_${randomBytes(24).toString('base64url')}`;
}
