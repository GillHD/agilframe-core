/**
 * Safe localStorage wrappers: private browsing / disabled storage must never
 * break the panel. All reads return null instead of throwing.
 */

export function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* storage is unavailable — the panel keeps working in memory */
  }
}

export function removeStorage(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

export function readCredential(key: string): string | null {
  try {
    const current = window.sessionStorage.getItem(key);
    const legacy = readStorage(key);
    if (!current && legacy) window.sessionStorage.setItem(key, legacy);
    if (legacy) removeStorage(key);
    return current ?? legacy;
  } catch {
    return null;
  }
}

export function storeCredential(key: string, value: string): void {
  removeStorage(key);
  try {
    if (value) window.sessionStorage.setItem(key, value);
    else window.sessionStorage.removeItem(key);
  } catch {
    // Browser storage can be disabled.
  }
}
