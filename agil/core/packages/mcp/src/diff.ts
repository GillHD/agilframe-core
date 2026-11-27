/**
 * Deep diff between two JSON documents, used by `agil_update_config` to show the
 * model exactly what changed (both for dry runs and after a real save).
 */
import { isPlainObject } from './tool-kit.js';

export interface ConfigChange {
  path: string;
  from?: unknown;
  to?: unknown;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((item, index) => sameValue(item, b[index]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    return sameValue(JSON.stringify(a), JSON.stringify(b));
  }
  return false;
}

function walk(before: unknown, after: unknown, prefix: string, out: ConfigChange[], maxEntries: number): void {
  if (out.length >= maxEntries) return;
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) {
      const path = prefix ? `${prefix}.${key}` : key;
      const from = before[key];
      const to = after[key];
      if (isPlainObject(from) && isPlainObject(to)) {
        walk(from, to, path, out, maxEntries);
        continue;
      }
      if (!sameValue(from, to)) out.push({ path, from, to });
      if (out.length >= maxEntries) return;
    }
    return;
  }
  if (!sameValue(before, after)) out.push({ path: prefix || '(root)', from: before, to: after });
}

/** Returns leaf-level changes (`theme.colors.primary`, `features.chat`, …). */
export function diffConfigs(before: unknown, after: unknown, maxEntries = 200): ConfigChange[] {
  const changes: ConfigChange[] = [];
  walk(before, after, '', changes, maxEntries);
  return changes;
}

/** One-line human summary of a change list. */
export function summarizeChanges(changes: readonly ConfigChange[]): string {
  if (changes.length === 0) return 'No changes.';
  if (changes.length === 1) return `1 change: ${changes[0]?.path ?? ''}`;
  return `${changes.length} changes: ${changes
    .slice(0, 5)
    .map((change) => change.path)
    .join(', ')}${changes.length > 5 ? ', …' : ''}`;
}
