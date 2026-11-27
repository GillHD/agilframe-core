/**
 * Theme → «Фон» gallery: six local landscape presets and a local-only upload.
 *
 * The card is mounted right above the raw background fields so a tenant admin
 * can pick a ready landscape in one click, see which preset is active, upload a
 * photo (compressed and embedded as a data URL) or remove the image entirely.
 * All file work happens in the browser — see `background-cache.ts` for the
 * compression, IndexedDB/localStorage cache and size limits.
 */
import { isLocalImageUrl, estimateDataUrlBytes, formatBytes, listCachedBackgrounds, deleteCachedBackground, cacheBackground, compressImageFile, BackgroundImageError, MAX_CONFIG_CHARS, type CachedBackground } from './background-cache';
import { backgroundPresetForUrl, backgroundPresets } from './background-presets';
import { el, button, isRecord } from './dom';
import { card, type FieldCtx, type Sync } from './fields';
import { tr } from './i18n';

function imageDescription(entry: CachedBackground): string {
  return `${entry.name || tr('Своё изображение')} · ${entry.width}×${entry.height} · ${formatBytes(entry.bytes)}`;
}

export interface BackgroundGallery {
  root: HTMLElement;
  sync: Sync;
}

type BackgroundValue = Record<string, unknown> & {
  type?: string;
  imageUrl?: string;
  gradient?: string;
  imagePosition?: string;
};

function truncateUrl(url: string): string {
  if (url.length <= 56) return url;
  return `${url.slice(0, 34)}…${url.slice(-16)}`;
}

/** Serialised size of the whole config, measured the same way the draft is. */
function serializedChars(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

function imageTile(label: string, imageUrl: string): HTMLButtonElement {
  const tile = el('button', 'bg-tile');
  tile.type = 'button';
  tile.title = label;
  tile.setAttribute('aria-pressed', 'false');
  const thumb = el('span', 'bg-tile-thumb');
  const image = el('img', 'bg-tile-img');
  image.src = imageUrl;
  image.alt = '';
  image.decoding = 'async';
  image.width = 160;
  image.height = 90;
  thumb.append(image);
  tile.append(thumb, el('span', 'bg-tile-name', label));
  return tile;
}

export function createBackgroundGallery(ctx: FieldCtx): BackgroundGallery {
  const shell = card(tr('Галерея фонов'), {
    className: 'bg-gallery-card',
    hint: tr('Выберите готовый фон комнаты или загрузите своё изображение.'),
  });

  const currentBackground = (): BackgroundValue => {
    const value = ctx.get('theme.background');
    return isRecord(value) ? (value as BackgroundValue) : {};
  };

  /* ------------------------------------------------------------------ */
  /* Preset grid                                                        */
  /* ------------------------------------------------------------------ */

  const grid = el('div', 'bg-gallery');
  grid.setAttribute('role', 'group');
  grid.setAttribute('aria-label', tr('Пресеты фона комнаты'));
  const presetButtons = new Map<string, HTMLButtonElement>();

  const applyBackground = (patch: BackgroundValue): void => {
    lastError = null;
    ctx.set('theme.background', { ...currentBackground(), ...patch });
  };

  for (const preset of backgroundPresets) {
    const label = tr(preset.label);
    const hint = tr(preset.hint);
    const tile = imageTile(label, preset.imageUrl);
    tile.dataset.testid = `bg-preset-${preset.id}`;
    tile.dataset.preset = preset.id;
    tile.title = `${label} — ${hint}`;
    tile.setAttribute('aria-label', `${label}: ${hint}`);
    tile.addEventListener('click', () => {
      applyBackground({
        type: 'image',
        imageUrl: preset.imageUrl,
        imagePosition: preset.imagePosition,
        gradient: preset.gradient,
      });
      ctx.toast(tr('Фон «{name}» применён', { name: label }), 'success');
    });
    presetButtons.set(preset.id, tile);
    grid.append(tile);
  }

  const noneTile = el('button', 'bg-tile bg-tile-none');
  noneTile.type = 'button';
  noneTile.dataset.testid = 'bg-preset-none';
  noneTile.setAttribute('aria-pressed', 'false');
  noneTile.setAttribute('aria-label', tr('Без изображения: использовать цвет или градиент фона'));
  noneTile.title = tr('Без изображения: цвет или градиент из полей ниже.');
  noneTile.append(el('span', 'bg-tile-none-mark', tr('Без изображения')));
  noneTile.addEventListener('click', () => {
    applyBackground({ type: 'solid', imageUrl: '' });
    ctx.toast(tr('Изображение фона убрано'), 'info');
  });
  grid.append(noneTile);

  /* ------------------------------------------------------------------ */
  /* Upload / remove                                                    */
  /* ------------------------------------------------------------------ */

  const uploadRow = el('div', 'bg-upload');
  const pickFile = button(tr('Загрузить изображение'), 'btn btn-small', 'upload');
  pickFile.dataset.testid = 'bg-pick-file';
  const fileHint = el('p', 'bg-upload-sub', tr('JPEG, PNG, WebP, AVIF или GIF · до 20 МБ'));
  fileHint.id = 'bg-upload-formats';
  pickFile.setAttribute('aria-describedby', fileHint.id);

  const fileInput = el('input', 'input input-file bg-file');
  fileInput.type = 'file';
  fileInput.hidden = true;
  fileInput.accept = 'image/jpeg,image/png,image/webp,image/avif,image/gif';
  fileInput.dataset.testid = 'bg-upload';
  fileInput.setAttribute('aria-label', tr('Загрузить своё изображение фона'));
  pickFile.addEventListener('click', () => fileInput.click());

  const removeButton = button(tr('Убрать фон'), 'btn btn-small bg-remove', 'trash');
  removeButton.dataset.testid = 'bg-remove';
  removeButton.disabled = true;

  const status = el('p', 'bg-status');
  status.dataset.testid = 'bg-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');

  const recent = el('div', 'bg-recent');
  const recentGrid = el('div', 'bg-gallery');
  recentGrid.setAttribute('role', 'group');
  recentGrid.setAttribute('aria-label', tr('Недавние изображения'));
  recent.append(el('h3', 'bg-upload-title', tr('Недавние изображения')), recentGrid);
  recent.hidden = true;
  const recentTiles = new Map<CachedBackground, HTMLButtonElement>();
  let recentRevision = 0;
  uploadRow.append(pickFile, removeButton);
  shell.body.append(grid, uploadRow, fileHint, fileInput, status, recent);

  /* ------------------------------------------------------------------ */
  /* State                                                              */
  /* ------------------------------------------------------------------ */

  let busy = false;
  let lastUpload: { dataUrl: string; title: string } | null = null;
  /** Kept after a failed upload so the following `sync()` cannot hide it. */
  let lastError: string | null = null;

  const setBusy = (value: boolean): void => {
    busy = value;
    fileInput.disabled = value;
    pickFile.disabled = value;
    pickFile.setAttribute('aria-busy', String(value));
    removeButton.disabled = value || !readImageUrl();
    uploadRow.classList.toggle('is-busy', value);
  };

  const readImageUrl = (): string => {
    const value = currentBackground().imageUrl;
    return typeof value === 'string' ? value : '';
  };

  const showStatus = (text: string, kind: 'idle' | 'preset' | 'custom' | 'external' | 'busy' | 'error' = 'idle'): void => {
    status.textContent = text;
    status.dataset.kind = kind;
  };

  const describe = (): void => {
    if (busy) {
      showStatus(tr('Сжимаем изображение в браузере…'), 'busy');
      return;
    }
    if (lastError) {
      showStatus(lastError, 'error');
      return;
    }
    const imageUrl = readImageUrl();
    if (!imageUrl || currentBackground().type !== 'image') {
      showStatus(tr('Изображение не выбрано — используется цвет или градиент из полей ниже.'), 'idle');
      return;
    }
    const preset = backgroundPresetForUrl(imageUrl);
    if (preset) {
      showStatus(tr('Выбран пресет «{name}». Картинка встроена в конфигурацию.', { name: tr(preset.label) }), 'preset');
      return;
    }
    const cached = [...recentTiles.keys()].find((entry) => entry.dataUrl === imageUrl);
    const description = lastUpload?.dataUrl === imageUrl ? lastUpload.title
      : cached ? imageDescription(cached) : null;
    if (description) {
      showStatus(tr('{description} — своё изображение в конфигурации.', { description }), 'custom');
      return;
    }
    if (isLocalImageUrl(imageUrl)) {
      showStatus(tr('Своё изображение в конфигурации: {size}.', { size: formatBytes(estimateDataUrlBytes(imageUrl)) }), 'custom');
      return;
    }
    showStatus(tr('Внешний URL изображения: {url}', { url: truncateUrl(imageUrl) }), 'external');
  };

  const sync = (): void => {
    const imageUrl = readImageUrl();
    const showingImage = Boolean(imageUrl) && currentBackground().type === 'image';
    const preset = showingImage ? backgroundPresetForUrl(imageUrl) : null;
    for (const [id, tile] of presetButtons) {
      const active = preset?.id === id;
      tile.setAttribute('aria-pressed', active ? 'true' : 'false');
      tile.classList.toggle('is-active', active);
    }
    const noneActive = !showingImage;
    noneTile.setAttribute('aria-pressed', noneActive ? 'true' : 'false');
    noneTile.classList.toggle('is-active', noneActive);
    for (const [entry, tile] of recentTiles) {
      const active = showingImage && entry.dataUrl === imageUrl;
      tile.setAttribute('aria-pressed', String(active));
      tile.classList.toggle('is-active', active);
    }
    removeButton.disabled = busy || !imageUrl;
    describe();
  };

  const applyCustom = (entry: CachedBackground): void => {
    const current = ctx.config();
    const nextBackground = { ...currentBackground(), type: 'image', imageUrl: entry.dataUrl, imagePosition: 'cover' };
    const projected = serializedChars({ ...current, theme: { ...current.theme, background: nextBackground } });
    if (projected > MAX_CONFIG_CHARS) {
      throw new BackgroundImageError('too_large', tr('Этот фон превышает лимит конфигурации. Выберите изображение меньшего размера.'));
    }
    applyBackground(nextBackground);
  };

  const refreshRecent = async (): Promise<void> => {
    const revision = ++recentRevision;
    const entries = await listCachedBackgrounds();
    if (revision !== recentRevision) return;
    recentTiles.clear();
    recentGrid.replaceChildren();
    for (const entry of entries) {
      if (!isLocalImageUrl(entry.dataUrl)) continue;
      const tile = imageTile(entry.name || tr('Своё изображение'), entry.dataUrl);
      tile.addEventListener('click', () => {
        try {
          applyCustom(entry);
        } catch (error) {
          lastError = error instanceof BackgroundImageError ? error.message : tr('Не удалось применить фон.');
          describe();
        }
      });
      recentTiles.set(entry, tile);
      recentGrid.append(tile);
    }
    recent.hidden = recentTiles.size === 0;
    sync();
  };
  /* ------------------------------------------------------------------ */
  /* Upload                                                             */
  /* ------------------------------------------------------------------ */

  const uploadFile = async (file: File): Promise<void> => {
    if (busy) return;
    lastUpload = null;
    lastError = null;
    const previous = ctx.get('theme.background');
    setBusy(true);
    showStatus(tr('Сжимаем изображение в браузере…'), 'busy');
    try {
      const entry = await compressImageFile(file);
      const storage = await cacheBackground(entry);
      await refreshRecent();
      if (ctx.get('theme.background') !== previous) {
        ctx.toast(storage === 'none' ? tr('Фон изменился во время загрузки. Выберите файл ещё раз.') : tr('Изображение добавлено в недавние.'), 'info');
        return;
      }
      lastUpload = {
        dataUrl: entry.dataUrl,
        title: imageDescription(entry),
      };
      applyCustom(entry);
      if (storage === 'none') {
        ctx.toast(tr('Фон загружен. Его копия осталась в черновике.'), 'info');
      } else {
        ctx.toast(tr('Фон загружен и добавлен в недавние.'), 'success');
      }
    } catch (error) {
      const message = error instanceof BackgroundImageError ? error.message : tr('Не удалось обработать изображение.');
      lastError = message;
      ctx.toast(message, 'error');
      showStatus(message, 'error');
    } finally {
      setBusy(false);
      sync();
    }
  };

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    fileInput.value = '';
    void uploadFile(file);
  });

  removeButton.addEventListener('click', () => {
    const imageUrl = readImageUrl();
    if (!imageUrl) return;
    const preset = backgroundPresetForUrl(imageUrl);
    applyBackground({ type: 'solid', imageUrl: '' });
    lastUpload = null;
    // Drop the cached copy of a custom upload; presets are bundled, not cached.
    if (!preset) {
      void listCachedBackgrounds()
        .then(async (entries) => {
          await Promise.all(entries.filter((entry) => entry.dataUrl === imageUrl).map((entry) => deleteCachedBackground(entry.id)));
          await refreshRecent();
        })
        .catch(() => undefined);
    }
    ctx.toast(preset ? tr('Пресет снят с фона') : tr('Своё изображение удалено из фона'), 'info');
  });

  void refreshRecent().catch(() => undefined);

  shell.body.append(
    el(
      'p',
      'bg-note',
      tr('До публикации изображение хранится в этом браузере. Кнопка «Сохранить в организации» применит фон к новым звонкам.'),
    ),
  );

  sync();
  return { root: shell.root, sync };
}
