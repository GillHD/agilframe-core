/**
 * Dashboard theming on top of the shared @agil/protocol tokens.
 *
 * The panel applies `toCssVars(displayTheme(...))` to `:root`, so the exact same
 * token set that skins the embeddable widget skins the admin UI. `auto` follows
 * `prefers-color-scheme` and demonstrates `displayTheme` dark derivation.
 */
import { displayTheme, themePresets, toCssVars, type ThemeTokens } from '@agil/protocol';
import { readStorage, writeStorage } from './storage.js';

export const THEME_STORAGE_KEY = 'agil_dashboard_theme';
export type ThemeMode = 'light' | 'dark' | 'auto';

/** Dashboard-only dark elevation; keep in sync with docs/design-system.md §2/§6. */
const DARK_DASHBOARD_SURFACES: Record<string, string> = {
  '--agil-color-surface': '#16243a',
  '--agil-color-surface-elevated': '#1d2d47',
  '--agil-color-background-alt': '#111a2b',
  '--agil-color-border': '#34445f',
  '--agil-color-divider': '#26364e',
};

function isThemeMode(value: string | null): value is ThemeMode {
  return value === 'light' || value === 'dark' || value === 'auto';
}

export class ThemeController {
  private mode: ThemeMode;
  private readonly root: HTMLElement;
  private readonly media: MediaQueryList;
  private readonly listeners = new Set<(mode: ThemeMode) => void>();
  private readonly onMediaChange = (): void => this.apply();

  constructor(root: HTMLElement = document.documentElement) {
    this.root = root;
    const stored = readStorage(THEME_STORAGE_KEY);
    this.mode = isThemeMode(stored) ? stored : 'auto';
    this.media = window.matchMedia('(prefers-color-scheme: dark)');
    if (typeof this.media.addEventListener === 'function') {
      this.media.addEventListener('change', this.onMediaChange);
    } else {
      this.media.addListener(this.onMediaChange);
    }
    this.apply();
  }

  getMode(): ThemeMode {
    return this.mode;
  }

  setMode(mode: ThemeMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    writeStorage(THEME_STORAGE_KEY, mode);
    this.apply();
    for (const listener of this.listeners) listener(mode);
  }

  onChange(listener: (mode: ThemeMode) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Explicit light/dark uses the matching preset; auto derives from the light one. */
  private resolve(): ThemeTokens {
    const prefersDark = this.media.matches;
    const base = structuredClone(this.mode === 'dark' ? themePresets.dark : themePresets.light);
    base.scheme = this.mode === 'auto' && !prefersDark ? 'light' : this.mode;
    return displayTheme(base, prefersDark);
  }

  apply(): void {
    const theme = this.resolve();
    const vars = toCssVars(theme);
    for (const [name, value] of Object.entries(vars)) this.root.style.setProperty(name, value);
    // The shared dark preset puts cards at ~1.12:1 over the page background,
    // which reads as flat surfaces in the admin panel. Lift only the dashboard
    // tokens (the widget/editor keep their own presets) to a visible elevation
    // (~1.25:1) and strengthen the border/divider contrast.
    if (vars['--agil-scheme'] === 'dark') {
      for (const [name, value] of Object.entries(DARK_DASHBOARD_SURFACES)) this.root.style.setProperty(name, value);
    }
    this.root.dataset.theme = theme.scheme;
    this.root.style.colorScheme = theme.scheme;
    this.root.style.setProperty('--agil-scheme', theme.scheme);
  }

  destroy(): void {
    if (typeof this.media.removeEventListener === 'function') {
      this.media.removeEventListener('change', this.onMediaChange);
    } else {
      this.media.removeListener(this.onMediaChange);
    }
    this.listeners.clear();
  }
}
