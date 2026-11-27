/**
 * Palette-correct scheme switching for the editor.
 *
 * `store.set('theme.scheme', …)` alone changes only the `scheme` flag while the
 * colour tokens stay from the previous palette (e.g. a dark theme switched to
 * "light" keeps white text on a light background in the preview). The widget
 * fixes this at runtime with `themeForScheme`; the editor must do the same so
 * the preview, the JSON export and PATCHed configs are coherent.
 *
 * Kept intentionally small and dependency-free: preset semantic colours +
 * the tenant's brand primary/accent/typography/shape/background image.
 */
import {
  generatePalette,
  relativeLuminance,
  themePresets,
  themeSchema,
  type ThemeScheme,
  type ThemeTokens,
} from '@agil/protocol';

/** True when the palette looks dark (dark background + light text). */
function isDarkPalette(theme: ThemeTokens): boolean {
  try {
    return relativeLuminance(theme.colors.background) < 0.4 && relativeLuminance(theme.colors.text) > 0.4;
  } catch {
    return false;
  }
}

export function themeForScheme(theme: ThemeTokens, scheme: ThemeScheme): ThemeTokens {
  if (scheme === 'auto') return theme;
  if (theme.scheme === scheme && isDarkPalette(theme) === (scheme === 'dark')) {
    // Already the requested scheme and palette: keep the tenant's hand-tuned
    // tokens (brand, typography, colours), only normalise the flag.
    return themeSchema.parse({ ...theme, scheme });
  }
  const preset = structuredClone(themePresets[scheme]);
  const brand = generatePalette(theme.colors.primary, scheme);
  const next: ThemeTokens = {
    ...preset,
    scheme,
    colors: {
      ...preset.colors,
      ...brand,
      accent: theme.colors.accent || brand.accent,
      onAccent: theme.colors.onAccent || brand.onAccent,
      // Keep tenant's video-stage tint so custom tiles do not jump on scheme change.
      tileBg: theme.colors.tileBg || preset.colors.tileBg,
      tileBorder: theme.colors.tileBorder || preset.colors.tileBorder,
      controlBg: preset.colors.controlBg,
      controlText: preset.colors.controlText,
    },
    typography: theme.typography,
    shape: theme.shape,
    spacing: theme.spacing,
    background: {
      ...preset.background,
      type: theme.background.type,
      imageUrl: theme.background.imageUrl,
      overlayOpacity: theme.background.overlayOpacity,
    },
    logo: theme.logo,
    motion: theme.motion,
  };
  return themeSchema.parse(next);
}
