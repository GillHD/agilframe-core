/**
 * Editor state: a complete `TenantConfig` plus a localStorage draft.
 *
 * All mutations are immutable at the path level, so the UI can bind inputs to
 * dotted paths (`theme.colors.primary`, `session.virtualBackgrounds.0.url`) and
 * re-sync only the affected widgets. Every change is persisted as a debounced
 * draft, and the preview iframe receives the config 150 ms after the last edit.
 */
import { defaultConfig, tenantConfigSchema, type TenantConfig } from '@agil/protocol';
import type { ConfigBase } from './api';
import { debounce, isRecord, readStorage, writeStorage } from './dom';

const DRAFT_KEY = 'agil.editor.draft.v1';
const EDITOR_THEME_KEY = 'agil.editor.theme';
const DARK_COLOR_SCHEME = '(prefers-color-scheme: dark)';
const DRAFT_SAVE_DELAY_MS = 400;

export type EditorTheme = 'light' | 'dark';

const LEGACY_MASCOT_NAME = 'Аги';
const DEFAULT_MASCOT_NAME = 'Agil';

/** Migration: old configs/drafts used «Аги» as the mascot default; now it is «Agil». */
export function migrateLegacyMascotName(config: TenantConfig): TenantConfig {
  const current = (config.branding.mascotName ?? '').trim();
  if (current !== '' && current !== LEGACY_MASCOT_NAME) return config;
  return { ...config, branding: { ...config.branding, mascotName: DEFAULT_MASCOT_NAME } };
}

function savedEditorTheme(): EditorTheme | undefined {
  const stored = readStorage(EDITOR_THEME_KEY);
  return stored === 'light' || stored === 'dark' ? stored : undefined;
}

export function loadEditorTheme(): EditorTheme {
  const stored = savedEditorTheme();
  if (stored) return stored;
  try {
    return window.matchMedia(DARK_COLOR_SCHEME).matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function watchSystemEditorTheme(apply: (theme: EditorTheme) => void): () => void {
  if (savedEditorTheme() || typeof window.matchMedia !== 'function') return () => {};
  const query = window.matchMedia(DARK_COLOR_SCHEME);
  const update = (event: MediaQueryListEvent): void => apply(event.matches ? 'dark' : 'light');
  query.addEventListener('change', update);
  return () => query.removeEventListener('change', update);
}

export function saveEditorTheme(theme: EditorTheme): void {
  writeStorage(EDITOR_THEME_KEY, theme);
}

/** Reads a dotted path from any JSON-like value. Missing segments yield `undefined`. */
export function getPath(source: unknown, path: string): unknown {
  let current: unknown = source;
  for (const key of path.split('.')) {
    if (Array.isArray(current)) {
      const index = Number(key);
      current = Number.isInteger(index) ? current[index] : undefined;
    } else if (isRecord(current)) {
      current = current[key];
    } else {
      return undefined;
    }
  }
  return current;
}

function setIn(node: unknown, keys: readonly string[], depth: number, value: unknown): unknown {
  if (depth >= keys.length) return value;
  const key = keys[depth];
  if (key === undefined) return value;
  if (Array.isArray(node)) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0) return node;
    const next = node.slice();
    next[index] = setIn(next[index], keys, depth + 1, value);
    return next;
  }
  const record: Record<string, unknown> = isRecord(node) ? { ...node } : {};
  record[key] = setIn(record[key], keys, depth + 1, value);
  return record;
}

/** Immutable set by dotted path. Arrays are addressed with numeric segments. */
export function setPath(source: TenantConfig, path: string, value: unknown): TenantConfig {
  if (!path) return source;
  return setIn(source, path.split('.'), 0, value) as TenantConfig;
}

/** Immutable update: `updatePath(config, path, (previous) => next)`. */
export function updatePath(
  source: TenantConfig,
  path: string,
  updater: (previous: unknown) => unknown,
): TenantConfig {
  return setPath(source, path, updater(getPath(source, path)));
}

export const DEFAULT_DRAFT_TENANT_ID = 'demo';

interface DraftPayload {
  savedAt: number;
  config: TenantConfig;
  base?: ConfigBase;
}

function loadDraft(fallbackTenantId: string, initialConfig?: TenantConfig, initialBase?: ConfigBase): DraftPayload {
  const raw = readStorage(DRAFT_KEY);
  const fallback = () => ({ config: migrateLegacyMascotName(initialConfig ?? defaultConfig({ tenantId: fallbackTenantId })), savedAt: 0, base: initialBase });
  if (!raw) return fallback();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) throw new Error('unexpected draft shape');
    const result = tenantConfigSchema.safeParse(parsed.config);
    if (!result.success) throw new Error('draft does not match the schema');
    if (result.data.tenantId !== fallbackTenantId) throw new Error('draft belongs to a different organization');
    const savedAt =
      typeof parsed.savedAt === 'number' && Number.isFinite(parsed.savedAt) ? parsed.savedAt : 0;
    let base = initialBase;
    if (initialBase && isRecord(parsed.base)) {
      if (parsed.base.serverUrl !== initialBase.serverUrl || parsed.base.tenantId !== initialBase.tenantId) return fallback();
      if (typeof parsed.base.etag === 'string' && /^[a-f0-9]{64}$/.test(parsed.base.etag)) {
        base = { ...initialBase, etag: parsed.base.etag };
      }
    }
    return { config: migrateLegacyMascotName(result.data), savedAt, base };
  } catch {
    // Corrupted or outdated draft: silently start from the protocol defaults.
    return fallback();
  }
}

export interface EditorStore {
  getConfig(): TenantConfig;
  getBase(): ConfigBase | undefined;
  setBase(base: ConfigBase): void;
  get(path: string): unknown;
  set(path: string, value: unknown): void;
  update(path: string, updater: (previous: unknown) => unknown): void;
  /** Replaces the whole config (validated imports). */
  replace(config: TenantConfig): void;
  reset(tenantId?: string): void;
  getRevision(): number;
  getDraftSavedAt(): number;
  flushDraft(): void;
  subscribe(listener: () => void): () => void;
  onDraftSaved(listener: (savedAt: number) => void): () => void;
}

export interface EditorStoreOptions {
  tenantId?: string;
  initialConfig?: TenantConfig;
  initialBase?: ConfigBase;
}

export function createEditorStore(options: EditorStoreOptions = {}): EditorStore {
  const initialTenantId = options.tenantId ?? DEFAULT_DRAFT_TENANT_ID;
  const loaded = loadDraft(initialTenantId, options.initialConfig, options.initialBase);

  let config: TenantConfig = loaded.config;
  let base = loaded.base;
  let draftSavedAt = loaded.savedAt;
  let revision = 0;

  const listeners = new Set<() => void>();
  const draftListeners = new Set<(savedAt: number) => void>();

  const persistDraft = (): void => {
    draftSavedAt = Date.now();
    const payload: DraftPayload = { savedAt: draftSavedAt, config, base };
    writeStorage(DRAFT_KEY, JSON.stringify(payload));
    for (const listener of draftListeners) listener(draftSavedAt);
  };

  const scheduleDraft = debounce(persistDraft, DRAFT_SAVE_DELAY_MS);

  const notify = (): void => {
    revision += 1;
    for (const listener of listeners) listener();
  };

  const commit = (next: TenantConfig): void => {
    config = next;
    scheduleDraft();
    notify();
  };

  return {
    getConfig: () => config,
    getBase: () => base,
    setBase: (next) => {
      base = next;
      scheduleDraft();
    },
    get: (path) => getPath(config, path),
    set: (path, value) => {
      commit(setPath(config, path, value));
    },
    update: (path, updater) => {
      commit(updatePath(config, path, updater));
    },
    replace: (next) => {
      commit(migrateLegacyMascotName(next));
    },
    reset: (tenantId) => {
      commit(migrateLegacyMascotName(defaultConfig({ tenantId: tenantId ?? config.tenantId })));
    },
    getRevision: () => revision,
    getDraftSavedAt: () => draftSavedAt,
    flushDraft: () => {
      scheduleDraft.flush();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onDraftSaved: (listener) => {
      draftListeners.add(listener);
      return () => {
        draftListeners.delete(listener);
      };
    },
  };
}
