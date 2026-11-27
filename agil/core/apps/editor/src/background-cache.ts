/**
 * Browser-local background image pipeline for the editor's «Фон» gallery.
 *
 * Uploads never leave the browser: the file is decoded to a canvas, scaled down
 * to at most `MAX_IMAGE_DIMENSION` px on the long side, re-encoded as WebP (JPEG
 * when WebP is unavailable) and embedded into the tenant config as a data URL,
 * so the same image works in the preview iframe, in the exported JSON and in the
 * widget after «Сохранить в организации».
 *
 * A copy is cached in IndexedDB (preferred) so the editor can restore/describe
 * the last upload after a reload even if the draft was replaced. Private modes
 * and quota errors fall back to a single localStorage slot with a hard size cap;
 * when both stores are unavailable the config still works — only the cache is
 * lost. See `docs` in the gallery card for the user-facing explanation.
 *
 * The pure helpers at the top are unit-tested in `test/background-cache.test.ts`.
 */

import { tr } from './i18n';

/** Longest side of the stored image, in CSS pixels. */
export const MAX_IMAGE_DIMENSION = 1280;

/**
 * Hard limit for the data URL embedded in `theme.background.imageUrl`.
 * ~700 000 chars ≈ 520 KB of binary image data: a 1280 px WebP/JPEG landscape
 * usually lands at 60–250 KB, so this only rejects pathological photos.
 */
export const MAX_BACKGROUND_DATA_URL_CHARS = 700_000;

/**
 * The server accepts 1 MiB JSON bodies (`JSON_BODY_LIMIT` in apps/server).
 * Keep a safety margin for the rest of the config and the HTTP envelope.
 */
export const MAX_CONFIG_CHARS = 900_000;

/** localStorage fallback budget shared by every cached background. */
export const FALLBACK_STORAGE_BUDGET = 2_000_000;

/** Raw files above this are rejected before decoding (memory guard). */
const MAX_UPLOAD_FILE_BYTES = 20 * 1024 * 1024;

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif']);

export type BackgroundImageErrorCode = 'unsupported' | 'too_large' | 'decode' | 'canvas';

export class BackgroundImageError extends Error {
  readonly code: BackgroundImageErrorCode;

  constructor(code: BackgroundImageErrorCode, message: string) {
    super(message);
    this.name = 'BackgroundImageError';
    this.code = code;
  }
}

export interface CachedBackground {
  id: string;
  dataUrl: string;
  name: string;
  mime: string;
  width: number;
  height: number;
  bytes: number;
  createdAt: number;
}

/* ------------------------------------------------------------------ */
/* Pure helpers (no DOM)                                               */
/* ------------------------------------------------------------------ */

/**
 * Collapses whitespace between tags so the data URL stays small. SVG content
 * inside text nodes is untouched (the presets have no text).
 */
export function minifySvg(svg: string): string {
  return svg.replace(/>\s+</g, '><').replace(/\s{2,}/g, ' ').trim();
}

/** Percent-encoded data URL — safe inside `url("…")` and `img.src`. */
export function svgToDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(minifySvg(svg))}`;
}

/** Estimated binary size of a base64 data URL (or the URL length for SVG). */
export function estimateDataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return dataUrl.length;
  const header = dataUrl.slice(0, comma);
  const payload = dataUrl.slice(comma + 1);
  if (!header.includes(';base64')) return payload.length;
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
}

/** Human «148 КБ» formatting for the gallery status line. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return tr('{size} Б', { size: Math.round(bytes) });
  if (bytes < 1024 * 1024) return tr('{size} КБ', { size: Math.round(bytes / 1024) });
  return tr('{size} МБ', { size: (bytes / (1024 * 1024)).toFixed(1) });
}

/** Short stable hash used to recognise an already cached image by its URL. */
export function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** True for the data URLs this module produces (presets and uploads). */
export function isLocalImageUrl(value: string): boolean {
  return /^data:image\/(?:svg\+xml|webp|jpeg|png|avif|gif)[;,]/.test(value);
}

/* ------------------------------------------------------------------ */
/* Compression                                                         */
/* ------------------------------------------------------------------ */

interface DecodedImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  release(): void;
}

async function decodeImage(file: File): Promise<DecodedImage> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file);
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        release: () => bitmap.close(),
      };
    } catch {
      // Fall through to the <img> decoder (older Safari, some AVIF builds).
    }
  }
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.decoding = 'async';
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new BackgroundImageError('decode', tr('Браузер не смог прочитать изображение.')));
      image.src = url;
    });
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      release: () => URL.revokeObjectURL(url),
    };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

function drawScaled(image: DecodedImage, maxDimension: number): HTMLCanvasElement {
  const scale = Math.min(1, maxDimension / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new BackgroundImageError('canvas', tr('Не удалось подготовить изображение в этом браузере.'));
  // Opaque matte: video backgrounds are full-bleed and a transparent PNG
  // would otherwise turn black in the JPEG fallback.
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(image.source, 0, 0, width, height);
  return canvas;
}

function encodeCanvas(canvas: HTMLCanvasElement, quality: number): { dataUrl: string; mime: string } {
  const webp = canvas.toDataURL('image/webp', quality);
  if (webp.startsWith('data:image/webp')) return { dataUrl: webp, mime: 'image/webp' };
  return { dataUrl: canvas.toDataURL('image/jpeg', quality), mime: 'image/jpeg' };
}

/**
 * Decodes, downscales and re-encodes the file. Tries progressively smaller
 * dimensions/qualities until the data URL fits the config budget.
 */
export async function compressImageFile(file: File): Promise<CachedBackground> {
  if (file.type === 'image/svg+xml') {
    throw new BackgroundImageError(
      'unsupported',
      tr('Выберите растровое изображение в формате JPEG, PNG, WebP, AVIF или GIF.'),
    );
  }
  if (file.type && !ALLOWED_MIME.has(file.type)) {
    throw new BackgroundImageError('unsupported', tr('Поддерживаются JPEG, PNG, WebP, AVIF и GIF.'));
  }
  if (file.size > MAX_UPLOAD_FILE_BYTES) {
    throw new BackgroundImageError('too_large', tr('Файл больше 20 МБ — уменьшите его перед загрузкой.'));
  }

  const decoded = await decodeImage(file);
  try {
    const attempts = [
      { dimension: MAX_IMAGE_DIMENSION, quality: 0.82 },
      { dimension: MAX_IMAGE_DIMENSION, quality: 0.68 },
      { dimension: 1024, quality: 0.62 },
      { dimension: 800, quality: 0.55 },
      { dimension: 640, quality: 0.5 },
    ];
    for (const attempt of attempts) {
      const canvas = drawScaled(decoded, attempt.dimension);
      const encoded = encodeCanvas(canvas, attempt.quality);
      if (encoded.dataUrl.length <= MAX_BACKGROUND_DATA_URL_CHARS) {
        return {
          id: `bg_${Date.now().toString(36)}_${fnv1a(encoded.dataUrl)}`,
          dataUrl: encoded.dataUrl,
          name: file.name.slice(0, 120),
          mime: encoded.mime,
          width: canvas.width,
          height: canvas.height,
          bytes: estimateDataUrlBytes(encoded.dataUrl),
          createdAt: Date.now(),
        };
      }
      // The canvas is garbage after each attempt; free the bitmap only once.
    }
    throw new BackgroundImageError(
      'too_large',
      tr('Не удалось сжать изображение до {size}. Возьмите более простое фото или меньшую область.', { size: formatBytes(MAX_BACKGROUND_DATA_URL_CHARS) }),
    );
  } finally {
    decoded.release();
  }
}

/* ------------------------------------------------------------------ */
/* IndexedDB cache (preferred)                                         */
/* ------------------------------------------------------------------ */

const DB_NAME = 'agil-editor';
const DB_VERSION = 1;
const STORE = 'backgrounds';
const LOCAL_KEY = 'agil.editor.backgrounds.v1';
/** Keep the browser cache bounded; only recent uploads are restorable. */
const MAX_CACHED_IMAGES = 6;

let databasePromise: Promise<IDBDatabase | null> | null = null;

function openDatabase(): Promise<IDBDatabase | null> {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise<IDBDatabase | null>((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    let settled = false;
    const finish = (value: IDBDatabase | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      finish(null);
      return;
    }
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => finish(request.result);
    request.onerror = () => finish(null);
    request.onblocked = () => finish(null);
    // Safari private mode can hang `open`; do not block the editor forever.
    window.setTimeout(() => finish(null), 2000);
  });
  return databasePromise;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

export async function cacheBackground(entry: CachedBackground): Promise<'indexeddb' | 'localStorage' | 'none'> {
  const database = await openDatabase();
  if (database) {
    try {
      const transaction = database.transaction(STORE, 'readwrite');
      const store = transaction.objectStore(STORE);
      store.put(entry);
      // IndexedDB has no list cap by itself: prune the oldest uploads so a
      // tenant picking many photos does not grow the cache without bound.
      const all = store.getAll();
      all.onsuccess = () => {
        const rows = (all.result as CachedBackground[]).sort((a, b) => b.createdAt - a.createdAt);
        for (const row of rows.slice(MAX_CACHED_IMAGES)) store.delete(row.id);
      };
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB write failed'));
        transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB write aborted'));
      });
      return 'indexeddb';
    } catch {
      // Quota or private mode: fall through to localStorage.
    }
  }
  return cacheBackgroundFallback(entry);
}

function readFallback(): CachedBackground[] {
  try {
    const raw = window.localStorage.getItem(LOCAL_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed.filter(isCachedBackground) as CachedBackground[]) : [];
  } catch {
    return [];
  }
}

function isCachedBackground(value: unknown): value is CachedBackground {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string' && typeof record.dataUrl === 'string';
}

function cacheBackgroundFallback(entry: CachedBackground): 'localStorage' | 'none' {
  const others = readFallback().filter((item) => item.id !== entry.id);
  let list = [entry, ...others].slice(0, 3);
  const serialized = (): string => JSON.stringify(list);
  const reduce = (): void => {
    list = list.slice(0, Math.max(0, list.length - 1));
  };
  let text = serialized();
  while (list.length > 1 && text.length > FALLBACK_STORAGE_BUDGET) {
    reduce();
    text = serialized();
  }
  if (text.length > FALLBACK_STORAGE_BUDGET) {
    // Single image larger than the fallback budget: keep it only when it is
    // small enough for localStorage at all.
    if (entry.dataUrl.length > FALLBACK_STORAGE_BUDGET) return 'none';
    list = [entry];
    text = serialized();
  }
  try {
    window.localStorage.setItem(LOCAL_KEY, text);
    return 'localStorage';
  } catch {
    return 'none';
  }
}

export async function listCachedBackgrounds(): Promise<CachedBackground[]> {
  let rows: CachedBackground[] = [];
  const database = await openDatabase();
  if (database) {
    try {
      const store = database.transaction(STORE, 'readonly').objectStore(STORE);
      rows = await requestResult(store.getAll() as IDBRequest<CachedBackground[]>);
    } catch {
      // fall through
    }
  }
  const byId = new Map([...readFallback(), ...rows].map((entry) => [entry.id, entry]));
  return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_CACHED_IMAGES);
}

export async function deleteCachedBackground(id: string): Promise<void> {
  if (!id) return;
  const database = await openDatabase();
  if (database) {
    try {
      const transaction = database.transaction(STORE, 'readwrite');
      transaction.objectStore(STORE).delete(id);
      await new Promise<void>((resolve) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => resolve();
        transaction.onabort = () => resolve();
      });
    } catch {
      // ignore: the fallback list is cleaned below as well
    }
  }
  const remaining = readFallback().filter((item) => item.id !== id);
  try {
    if (remaining.length > 0) window.localStorage.setItem(LOCAL_KEY, JSON.stringify(remaining));
    else window.localStorage.removeItem(LOCAL_KEY);
  } catch {
    // ignore
  }
}
