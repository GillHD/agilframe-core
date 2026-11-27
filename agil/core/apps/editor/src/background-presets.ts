/**
 * Local landscape presets for the editor's «Фон» gallery.
 *
 * The SVGs live in `src/backgrounds/*.svg` and are committed to the repository —
 * no external hotlinks, no runtime network requests. They are bundled as raw
 * text and exposed as percent-encoded data URLs, which means a selected preset
 * survives an export/import cycle and renders in the widget on any host.
 *
 * Each preset also carries a CSS-gradient fallback: if an old browser refuses
 * the data URL, the widget still paints a matching sky (`background.gradient`).
 */
import alpineDawnSvg from './backgrounds/alpine-dawn.svg?raw';
import duneSunsetSvg from './backgrounds/dune-sunset.svg?raw';
import mistyHillsSvg from './backgrounds/misty-hills.svg?raw';
import northernLightsSvg from './backgrounds/northern-lights.svg?raw';
import pineLakeSvg from './backgrounds/pine-lake.svg?raw';
import seaHorizonSvg from './backgrounds/sea-horizon.svg?raw';
import { svgToDataUrl } from './background-cache';

export type BackgroundPosition = 'center' | 'top' | 'bottom' | 'cover';

export interface BackgroundPreset {
  id: string;
  label: string;
  /** Short Russian description used as the tile's accessible hint. */
  hint: string;
  /** CSS gradient shown by the widget when the image cannot load. */
  gradient: string;
  imagePosition: BackgroundPosition;
  /** Percent-encoded `data:image/svg+xml` URL, bundled from the local SVG. */
  imageUrl: string;
}

interface PresetSource {
  id: string;
  label: string;
  hint: string;
  gradient: string;
  svg: string;
}

const SOURCES: readonly PresetSource[] = [
  {
    id: 'alpine-dawn',
    label: 'Альпийский рассвет',
    hint: 'Розовое небо, снежные вершины и горное озеро.',
    gradient: 'linear-gradient(180deg, #233a63 0%, #b06a86 38%, #f2a184 62%, #ffe9c8 100%)',
    svg: alpineDawnSvg,
  },
  {
    id: 'pine-lake',
    label: 'Лесное озеро',
    hint: 'Утренний туман, хвойный лес и спокойная вода.',
    gradient: 'linear-gradient(180deg, #cfe9ef 0%, #eaf6f2 55%, #f7fbf3 100%)',
    svg: pineLakeSvg,
  },
  {
    id: 'dune-sunset',
    label: 'Дюны на закате',
    hint: 'Тёплый закат над песчаными барханами.',
    gradient: 'linear-gradient(180deg, #5b3f7a 0%, #b9567a 30%, #ef8354 58%, #ffe0a3 100%)',
    svg: duneSunsetSvg,
  },
  {
    id: 'northern-lights',
    label: 'Северное сияние',
    hint: 'Звёздное небо, зелёные сполохи и снежные холмы.',
    gradient: 'linear-gradient(180deg, #040d1c 0%, #0a2038 45%, #123b4a 75%, #1d5560 100%)',
    svg: northernLightsSvg,
  },
  {
    id: 'misty-hills',
    label: 'Туманные холмы',
    hint: 'Мягкий свет, зелёные склоны и слоистая дымка.',
    gradient: 'linear-gradient(180deg, #e8f1ea 0%, #f3f7ef 50%, #fbf8ee 100%)',
    svg: mistyHillsSvg,
  },
  {
    id: 'sea-horizon',
    label: 'Морской горизонт',
    hint: 'Синее небо, облака и солнечная дорожка на воде.',
    gradient: 'linear-gradient(180deg, #2f7cbb 0%, #7db8dd 42%, #cbe6f3 72%, #f6ecd6 100%)',
    svg: seaHorizonSvg,
  },
];

/** 4–6 attractive presets; the gallery is driven entirely by this list. */
export const backgroundPresets: readonly BackgroundPreset[] = SOURCES.map((source) => ({
  id: source.id,
  label: source.label,
  hint: source.hint,
  gradient: source.gradient,
  imagePosition: 'cover',
  imageUrl: svgToDataUrl(source.svg),
}));

export function backgroundPresetById(id: string): BackgroundPreset | undefined {
  return backgroundPresets.find((preset) => preset.id === id);
}

/** Returns the preset whose data URL is currently applied, if any. */
export function backgroundPresetForUrl(imageUrl: string): BackgroundPreset | undefined {
  if (!imageUrl) return undefined;
  return backgroundPresets.find((preset) => preset.imageUrl === imageUrl);
}
