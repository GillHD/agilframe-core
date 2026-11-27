/**
 * Generic form renderer driven by the zod schemas of `@agil/protocol`.
 *
 * Booleans become switches, numbers become number inputs with the `min`/`max`
 * from the schema, enums become selects, arrays of enums become chip
 * multi-selects, arrays of objects become editable tables and nested objects
 * become groups. Sections only supply Russian labels/hints and custom widgets
 * for the few composite fields (codec pair, country picker, colour tokens).
 *
 * Every builder returns a `Sync` function. `main.ts` calls all syncs after each
 * state change so DOM values follow the config without re-creating inputs
 * (this preserves focus and caret position while typing).
 */
import { isHexColor, normalizeHex, type TenantConfig } from '@agil/protocol';
import { z } from 'zod';
import {
  badge,
  button,
  el,
  humanizeKey,
  iconButton,
  type BadgeTone,
  type ToastTone,
} from './dom';
import { tr } from './i18n';

export type Sync = () => void;

export interface FieldCtx {
  get(path: string): unknown;
  set(path: string, value: unknown): void;
  invalidText: Map<string, { value: string; message: string }>;
  /** Full current config — used by sections that need cross-field values. */
  config(): TenantConfig;
  /** Re-renders the active section (after adding/removing table rows). */
  refresh(): void;
  toast(message: string, tone?: ToastTone): void;
}

export function combineSyncs(syncs: readonly Sync[]): Sync {
  return () => {
    for (const sync of syncs) sync();
  };
}

/* ------------------------------------------------------------------ */
/* Typed reads (the store only exposes `unknown`)                      */
/* ------------------------------------------------------------------ */

export function readString(ctx: FieldCtx, path: string, fallback = ''): string {
  const value = ctx.get(path);
  return typeof value === 'string' ? value : fallback;
}

export function readNumber(ctx: FieldCtx, path: string, fallback = 0): number {
  const value = ctx.get(path);
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function readBoolean(ctx: FieldCtx, path: string, fallback = false): boolean {
  const value = ctx.get(path);
  return typeof value === 'boolean' ? value : fallback;
}

export function readArray(ctx: FieldCtx, path: string): unknown[] {
  const value = ctx.get(path);
  return Array.isArray(value) ? value : [];
}

export function readStringArray(ctx: FieldCtx, path: string): string[] {
  return readArray(ctx, path).filter((value): value is string => typeof value === 'string');
}

/* ------------------------------------------------------------------ */
/* Shells                                                              */
/* ------------------------------------------------------------------ */

interface FieldShell {
  root: HTMLDivElement;
  head: HTMLDivElement;
  body: HTMLDivElement;
}

export function fieldShell(
  title: string,
  options: { inline?: boolean; hint?: string; badge?: BadgeTone } = {},
): FieldShell {
  const root = el('div', options.inline ? 'field field-inline' : 'field');
  const head = el('div', 'field-head');
  head.append(el('span', 'field-label', tr(title)));
  if (options.badge) {
    const label = options.badge === 'roadmap' ? tr('В плане') : options.badge === 'beta' ? tr('Бета') : options.badge;
    head.append(badge(label, options.badge));
  }
  root.append(head);
  if (options.hint) root.append(el('p', 'field-hint', tr(options.hint)));
  const body = el('div', 'field-body');
  root.append(body);
  return { root, head, body };
}

export interface CardOptions {
  hint?: string;
  badge?: string;
  tone?: BadgeTone;
  className?: string;
}

export interface CardShell {
  root: HTMLElement;
  head: HTMLElement;
  body: HTMLElement;
}

function updateCardToggle(toggle: HTMLElement, title: string, collapsed: boolean): void {
  toggle.setAttribute('aria-expanded', String(!collapsed));
  toggle.setAttribute('aria-label', tr(collapsed ? 'Развернуть блок «{title}»' : 'Свернуть блок «{title}»', { title }));
  toggle.textContent = collapsed ? '▸' : '▾';
}

export function card(title: string, options: CardOptions = {}): CardShell {
  const label = tr(title);
  const root = el('section', options.className ? `card ${options.className}` : 'card');
  const head = el('div', 'card-head');
  head.append(el('h2', 'card-title', label));
  if (options.badge) head.append(badge(tr(options.badge), options.tone ?? 'muted'));
  const body = el('div', 'card-body');
  if (options.hint) body.append(el('p', 'card-hint', tr(options.hint)));
  const toggle = el('button', 'card-toggle');
  toggle.type = 'button';
  toggle.dataset.cardToggle = '';
  updateCardToggle(toggle, label, false);
  toggle.addEventListener('click', () => {
    const collapsed = root.classList.toggle('is-collapsed');
    updateCardToggle(toggle, label, collapsed);
  });
  head.append(toggle);
  root.append(head, body);
  return { root, head, body };
}

/* ------------------------------------------------------------------ */
/* Leaf widgets                                                        */
/* ------------------------------------------------------------------ */

export function toggleField(
  ctx: FieldCtx,
  parent: HTMLElement,
  path: string,
  title: string,
  options: { hint?: string; badge?: BadgeTone } = {},
): Sync {
  const shell = fieldShell(title, { inline: true, hint: options.hint, badge: options.badge });
  shell.body.remove();
  const control = el('button', 'switch');
  control.type = 'button';
  control.dataset.fieldPath = path;
  control.dataset.fieldKind = 'switch';
  control.setAttribute('role', 'switch');
  control.setAttribute('aria-label', tr(title));
  control.append(el('span', 'switch-knob'));
  shell.head.append(control);
  parent.append(shell.root);

  const sync: Sync = () => {
    control.setAttribute('aria-checked', readBoolean(ctx, path) ? 'true' : 'false');
  };
  control.addEventListener('click', () => {
    ctx.set(path, !readBoolean(ctx, path));
  });
  sync();
  return sync;
}

export interface NumberBounds {
  min?: number;
  max?: number;
  step: number;
  int: boolean;
}

function numberBounds(schema: z.ZodNumber): NumberBounds {
  const min = schema.minValue ?? undefined;
  const max = schema.maxValue ?? undefined;
  const int = schema.isInt;
  let step = 1;
  if (!int) {
    const span = min !== undefined && max !== undefined ? max - min : 1;
    step = span <= 1 ? 0.01 : span <= 20 ? 0.1 : 0.5;
  }
  return { min, max, step, int };
}

export function numberField(
  ctx: FieldCtx,
  parent: HTMLElement,
  path: string,
  title: string,
  bounds: NumberBounds,
  options: { hint?: string; optional?: boolean } = {},
): Sync {
  const shell = fieldShell(title, { hint: options.hint });
  const input = el('input', 'input input-number');
  input.type = 'number';
  input.dataset.fieldPath = path;
  input.dataset.fieldKind = 'number';
  if (options.optional) input.placeholder = tr('Автоматически');
  input.setAttribute('aria-label', tr(title));
  if (bounds.min !== undefined) input.min = String(bounds.min);
  if (bounds.max !== undefined) input.max = String(bounds.max);
  input.step = String(bounds.step);
  input.inputMode = bounds.int ? 'numeric' : 'decimal';
  shell.body.append(input);
  parent.append(shell.root);

  const normalize = (value: number): number => {
    let next = value;
    if (bounds.min !== undefined) next = Math.max(bounds.min, next);
    if (bounds.max !== undefined) next = Math.min(bounds.max, next);
    next = bounds.int ? Math.round(next) : Math.round(next / bounds.step) * bounds.step;
    return Number(next.toFixed(4));
  };

  const read = (): number | undefined => {
    const raw = ctx.get(path);
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : options.optional ? undefined : 0;
  };
  const update = (blurred: boolean): void => {
    const previous = read();
    const raw = input.validity.badInput ? NaN : options.optional && input.value === '' ? undefined : Number(input.value);
    const next = raw === undefined ? undefined : Number.isFinite(raw) ? normalize(raw) : previous;
    if (!blurred && raw !== undefined && (next === undefined || !Number.isFinite(raw) || Math.abs(next - raw) >= 1e-9)) {
      input.setAttribute('aria-invalid', 'true');
      return;
    }
    if (blurred) input.value = next === undefined ? '' : String(next);
    input.setAttribute('aria-invalid', 'false');
    if (next !== previous) ctx.set(path, next);
  };
  input.addEventListener('input', () => update(false));
  input.addEventListener('blur', () => update(true));

  const sync: Sync = () => {
    if (document.activeElement === input) return;
    const value = read();
    const text = value === undefined ? '' : String(value);
    if (input.value !== text) input.value = text;
    input.setAttribute('aria-invalid', 'false');
  };
  sync();
  return sync;
}

export function textField(
  ctx: FieldCtx,
  parent: HTMLElement,
  path: string,
  title: string,
  options: { hint?: string; placeholder?: string; maxLength?: number; onChange?: (value: string) => void } = {},
): Sync {
  const shell = fieldShell(title, { hint: options.hint });
  const input = el('input', 'input input-text');
  input.type = 'text';
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.dataset.fieldPath = path;
  input.dataset.fieldKind = 'text';
  input.setAttribute('aria-label', tr(title));
  if (options.maxLength !== undefined) input.maxLength = options.maxLength;
  if (options.placeholder) input.placeholder = options.placeholder;
  shell.body.append(input);
  parent.append(shell.root);

  input.addEventListener('input', () => {
    if (input.value === readString(ctx, path)) return;
    if (options.onChange) options.onChange(input.value);
    else ctx.set(path, input.value);
  });

  const sync: Sync = () => {
    if (document.activeElement === input) return;
    const value = readString(ctx, path);
    if (input.value !== value) input.value = value;
  };
  sync();
  return sync;
}

export function textareaField(
  ctx: FieldCtx,
  parent: HTMLElement,
  path: string,
  title: string,
  options: { hint?: string; rows?: number; placeholder?: string } = {},
): Sync {
  const shell = fieldShell(title, { hint: options.hint });
  const area = el('textarea', 'input input-textarea');
  area.spellcheck = false;
  area.rows = options.rows ?? 4;
  area.dataset.fieldPath = path;
  area.dataset.fieldKind = 'textarea';
  area.setAttribute('aria-label', tr(title));
  if (options.placeholder) area.placeholder = options.placeholder;
  shell.body.append(area);
  parent.append(shell.root);

  area.addEventListener('input', () => {
    if (area.value !== readString(ctx, path)) ctx.set(path, area.value);
  });

  const sync: Sync = () => {
    if (document.activeElement === area) return;
    const value = readString(ctx, path);
    if (area.value !== value) area.value = value;
  };
  sync();
  return sync;
}

/** Human Russian labels for raw protocol enum values (technical value stays in title). */
const VALUE_LABELS: Record<string, string> = {
  'role-defaults': 'Права роли по умолчанию',
  strict: 'Строгие права',
  grid: 'Сетка (grid)',
  spotlight: 'Крупный план (spotlight)',
  sidebar: 'С боковой панелью (sidebar)',
  corner: 'В углу (corner)',
  pip: 'Картинка в картинке (PiP)',
  hidden: 'Скрыто (hidden)',
  'bottom-center': 'Снизу по центру',
  'bottom-left': 'Снизу слева',
  'bottom-right': 'Снизу справа',
  'top-center': 'Сверху по центру',
  'top-right': 'Сверху справа',
  bar: 'Полоса (bar)',
  island: 'Остров (island)',
  minimal: 'Минимальный (minimal)',
  full: 'Полный (full)',
  compact: 'Компактный (compact)',
  none: 'Нет (none)',
  right: 'Справа',
  left: 'Слева',
  contain: 'Вписывать (contain)',
  cover: 'Заполнять (cover)',
  'client-only': 'Только клиент (client-only)',
  'server-assisted': 'Серверная обработка (server-assisted)',
  mesh: 'Прямой (mesh)',
  sfu: 'SFU (пересылка)',
  broadcast: 'Трансляция (broadcast)',
  local: 'Локально',
  external: 'Внешний',
  hybrid: 'Гибридный',
  builtin: 'Встроенный',
  'reduce-video': 'Снижать качество видео',
  'audio-only': 'Только звук',
  'chat-first': 'Сначала чат',
  light: 'Светлая',
  dark: 'Тёмная',
  auto: 'Автоматически',
  off: 'Выключено',
  'prefer-hardware': 'Аппаратный энкодер',
  'software-only': 'Приоритет совместимости',
  'livekit-egress': 'LiveKit Egress',
  host: 'Ведущий (host)',
  moderator: 'Модератор (moderator)',
  guest: 'Гость (guest)',
  anonymous: 'Анонимный (anonymous)',
  admin: 'Администратор',
  system: 'Система',
  av1: 'AV1',
  h264: 'H.264',
  vp9: 'VP9',
  vp8: 'VP8',
  pcmu: 'G.711 μ-law',
  g722: 'G.722',
  red: 'RED',
  balanced: 'Сбалансированно',
  'maintain-framerate': 'Держать частоту кадров',
  'maintain-resolution': 'Держать разрешение',
  comfortable: 'Комфортная',
  spacious: 'Свободная',
  gradient: 'Градиент',
  image: 'Изображение',
  color: 'Цвет',
  solid: 'Однотонный',
  center: 'По центру',
  top: 'Сверху',
  bottom: 'Снизу',
  watermark: 'Водяной знак',
  normal: 'Обычная',
  fast: 'Быстрая',
  slow: 'Медленная',
  'header-left': 'Слева в шапке',
  'header-center': 'По центру шапки',
  'header-right': 'Справа в шапке',
  opus: 'Opus',
  '720p': '720p (HD)',
  '1080p': '1080p (Full HD)',
  '360p': '360p',
  '480p': '480p',
  ru: 'Русский',
  en: 'English',
  webm: 'WebM',
  mp4: 'MP4',
  browser: 'Браузер',
  token: 'Токен (token)',
  password: 'Пароль (password)',
  motion: 'Движение',
  detail: 'Детали',
  static: 'Постоянные',
  rest: 'Временные (coturn)',
  text: 'Текст',
};

/** Mobile-only card accordion: keeps every field, but collapses secondary blocks. */
export function initMobileCards(container: HTMLElement, expanded?: ReadonlySet<number>): void {
  const mobile = window.matchMedia('(max-width: 900px)').matches;
  const cards = [...container.querySelectorAll<HTMLElement>('.card')];
  cards.forEach((card, index) => {
    const collapsed = mobile && (expanded ? !expanded.has(index) : index > 0);
    card.classList.toggle('is-collapsed', collapsed);
    const toggle = card.querySelector<HTMLElement>('[data-card-toggle]');
    if (toggle) {
      const title = card.querySelector('.card-title')?.textContent ?? '';
      updateCardToggle(toggle, title, collapsed);
    }
  });
}

export function enumValueLabel(value: string): string {
  const label = VALUE_LABELS[value];
  return label ? tr(label) : value;
}

export function selectField(
  ctx: FieldCtx,
  parent: HTMLElement,
  path: string,
  title: string,
  options: readonly string[],
  fieldOptions: { hint?: string; labels?: Record<string, string> } = {},
): Sync {
  const shell = fieldShell(title, { hint: fieldOptions.hint });
  const select = el('select', 'input input-select');
  select.dataset.fieldPath = path;
  select.dataset.fieldKind = 'select';
  select.setAttribute('aria-label', tr(title));
  const tech = el('span', 'field-tech');
  tech.setAttribute('aria-hidden', 'true');
  for (const option of options) {
    const node = el('option');
    node.value = option;
    const label = fieldOptions.labels?.[option];
    node.textContent = label ? tr(label) : enumValueLabel(option);
    node.title = option;
    select.append(node);
  }
  shell.body.append(select, tech);
  parent.append(shell.root);

  select.addEventListener('change', () => {
    ctx.set(path, select.value);
  });

  const sync: Sync = () => {
    if (document.activeElement === select) return;
    const value = readString(ctx, path);
    if (value && select.value !== value) select.value = value;
    tech.textContent = value ? tr('значение: {value}', { value }) : '';
    tech.hidden = !value;
  };
  sync();
  return sync;
}

export interface MultiSelectOptions {
  hint?: string;
  badge?: BadgeTone;
  minSelected?: number;
  labels?: Record<string, string>;
  validate?: (values: string[]) => string | undefined;
  onChange?: (values: string[]) => void;
}

/** Keeps the schema's declaration order and preserves unknown values from the server. */
export function orderValues(options: readonly string[], values: readonly string[]): string[] {
  const known = options.filter((option) => values.includes(option));
  const extra = values.filter((value) => !options.includes(value));
  return [...known, ...extra];
}

export function multiSelectField(
  ctx: FieldCtx,
  parent: HTMLElement,
  path: string,
  title: string,
  options: readonly string[],
  fieldOptions: MultiSelectOptions = {},
): Sync {
  const shell = fieldShell(title, { hint: fieldOptions.hint, badge: fieldOptions.badge });
  const chips = el('div', 'chips');
  chips.dataset.fieldPath = path;
  chips.dataset.fieldKind = 'chips';
  const buttons = new Map<string, HTMLButtonElement>();

  for (const option of options) {
    const chip = el('button', 'chip', tr(fieldOptions.labels?.[option] ?? option));
    chip.type = 'button';
    chip.setAttribute('aria-pressed', 'false');
    chip.addEventListener('click', () => {
      const current = readStringArray(ctx, path);
      const next = current.includes(option)
        ? current.filter((value) => value !== option)
        : [...current, option];
      if (fieldOptions.minSelected !== undefined && next.length < fieldOptions.minSelected) {
        ctx.toast(tr('Оставьте хотя бы один вариант.'), 'error');
        return;
      }
      const ordered = orderValues(options, next);
      const error = fieldOptions.validate?.(ordered);
      if (error) {
        ctx.toast(error, 'error');
        return;
      }
      if (fieldOptions.onChange) fieldOptions.onChange(ordered);
      else ctx.set(path, ordered);
    });
    buttons.set(option, chip);
    chips.append(chip);
  }

  shell.body.append(chips);
  parent.append(shell.root);

  const sync: Sync = () => {
    const current = readStringArray(ctx, path);
    for (const [option, chip] of buttons) {
      chip.setAttribute('aria-pressed', current.includes(option) ? 'true' : 'false');
    }
  };
  sync();
  return sync;
}

/** Free-form string list edited as comma separated values. */
export function listField(
  ctx: FieldCtx,
  parent: HTMLElement,
  path: string,
  title: string,
  options: { hint?: string; placeholder?: string } = {},
): Sync {
  const shell = fieldShell(title, { hint: options.hint });
  const input = el('input', 'input input-text');
  input.type = 'text';
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.dataset.fieldPath = path;
  input.dataset.fieldKind = 'list';
  input.placeholder = tr(options.placeholder ?? 'значение 1, значение 2');
  input.setAttribute('aria-label', tr(title));
  shell.body.append(input);
  parent.append(shell.root);

  input.addEventListener('input', () => {
    const values = input.value
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    if (values.join('\u0000') !== readStringArray(ctx, path).join('\u0000')) ctx.set(path, values);
  });

  const sync: Sync = () => {
    if (document.activeElement === input) return;
    const value = readStringArray(ctx, path).join(', ');
    if (input.value !== value) input.value = value;
  };
  sync();
  return sync;
}

export interface ColorInput {
  root: HTMLElement;
  sync: Sync;
}

/** `type=color` swatch + hex text field, validated with `isHexColor`. */
export function colorInput(ctx: FieldCtx, path: string, title: string): ColorInput {
  const root = el('div', 'color-input');
  const picker = el('input', 'color-picker');
  picker.type = 'color';
  picker.setAttribute('aria-label', tr('{title}: выбрать цвет', { title }));
  const hex = el('input', 'input input-hex');
  hex.type = 'text';
  hex.spellcheck = false;
  hex.autocomplete = 'off';
  hex.dataset.fieldPath = path;
  hex.dataset.fieldKind = 'color';
  hex.maxLength = 9;
  hex.setAttribute('aria-label', tr('{title}: код цвета в формате hex', { title }));
  root.append(picker, hex);

  const apply = (value: string, source: 'picker' | 'hex'): void => {
    if (!isHexColor(value)) {
      if (source === 'hex') hex.setAttribute('aria-invalid', 'true');
      return;
    }
    const trimmed = value.trim().toLowerCase();
    // Keep #rrggbbaa intact (focusRing/overlay/shadow use alpha), the native
    // picker only understands #rrggbb.
    const stored = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
    const normalized = normalizeHex(value);
    hex.setAttribute('aria-invalid', 'false');
    if (source === 'picker') hex.value = normalized;
    if (readString(ctx, path) !== stored) ctx.set(path, stored);
  };

  picker.addEventListener('input', () => apply(picker.value, 'picker'));
  hex.addEventListener('input', () => apply(hex.value, 'hex'));
  hex.addEventListener('blur', () => {
    hex.value = readString(ctx, path);
    hex.setAttribute('aria-invalid', 'false');
  });

  const sync: Sync = () => {
    const value = readString(ctx, path);
    if (!isHexColor(value)) return;
    picker.value = normalizeHex(value).slice(0, 7);
    if (document.activeElement !== hex) hex.value = value;
  };
  sync();
  return { root, sync };
}

/* ------------------------------------------------------------------ */
/* Tables (arrays of zod objects)                                      */
/* ------------------------------------------------------------------ */

export interface TableOptions {
  labels?: Record<string, string>;
  hints?: Record<string, string>;
  hint?: string;
  addLabel?: string;
  idPrefix?: string;
  emptyText?: string;
  /** Static defaults or a factory (e.g. to generate a unique valid row id). */
  defaults?: Record<string, unknown> | (() => Record<string, unknown>);
}

function defaultRow(schema: z.ZodObject, options: TableOptions): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  const idPrefix = options.idPrefix ?? 'row';
  const shape: z.ZodRawShape = schema.shape;
  const defaults = typeof options.defaults === 'function' ? options.defaults() : options.defaults;
  for (const [key, rawSchema] of Object.entries(shape)) {
    const field = unwrapSchema(rawSchema);
    if (key in (defaults ?? {})) {
      row[key] = defaults?.[key];
    } else if (field instanceof z.ZodBoolean) {
      row[key] = false;
    } else if (field instanceof z.ZodNumber) {
      row[key] = field.minValue ?? 0;
    } else if (field instanceof z.ZodEnum) {
      row[key] = field.options[0] ?? '';
    } else if (key === 'id') {
      row[key] = `${idPrefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    } else {
      row[key] = '';
    }
  }
  return row;
}

function renderTableRow(
  ctx: FieldCtx,
  tablePath: string,
  index: number,
  schema: z.ZodObject,
  options: TableOptions,
): { node: HTMLElement; syncs: Sync[] } {
  const rowPath = `${tablePath}.${index}`;
  const node = el('div', 'table-row');
  const head = el('div', 'table-row-head');
  head.append(el('span', 'table-row-index', `#${index + 1}`));
  const remove = iconButton('trash', tr('Удалить строку'), 'icon-button icon-button-danger');
  remove.addEventListener('click', () => {
    const rows = readArray(ctx, tablePath).slice();
    rows.splice(index, 1);
    ctx.set(tablePath, rows);
    ctx.refresh();
  });
  head.append(remove);
  node.append(head);
  const rendered = renderSchema(schema, rowPath, ctx, {
    labels: options.labels,
    hints: options.hints,
  });
  node.append(rendered.node);
  return { node, syncs: rendered.syncs };
}

export function tableField(
  ctx: FieldCtx,
  parent: HTMLElement,
  path: string,
  schema: z.ZodObject,
  title: string,
  options: TableOptions = {},
): Sync {
  const shell = fieldShell(title, { hint: options.hint });
  const count = badge('0', 'muted');
  shell.head.append(count);
  const rowsHost = el('div', 'table-rows');
  const rows = readArray(ctx, path);
  const syncs: Sync[] = [];

  if (rows.length === 0) {
    rowsHost.append(el('p', 'field-hint', tr(options.emptyText ?? 'Пусто — добавьте первую запись.')));
  }
  rows.forEach((_row, index) => {
    const rendered = renderTableRow(ctx, path, index, schema, options);
    rowsHost.append(rendered.node);
    syncs.push(...rendered.syncs);
  });

  const add = button(tr(options.addLabel ?? 'Добавить строку'), 'btn btn-small', 'plus');
  add.addEventListener('click', () => {
    const next = [...readArray(ctx, path), defaultRow(schema, options)];
    ctx.set(path, next);
    ctx.refresh();
  });
  shell.body.append(rowsHost, add);
  parent.append(shell.root);

  const syncCount: Sync = () => {
    const total = readArray(ctx, path).length;
    count.textContent = String(total);
  };
  syncCount();
  return combineSyncs([syncCount, ...syncs]);
}

/* ------------------------------------------------------------------ */
/* Schema walker                                                       */
/* ------------------------------------------------------------------ */

function unwrapSchema(schema: z.core.$ZodType): z.core.$ZodType {
  let current: z.core.$ZodType = schema;
  for (let guard = 0; guard < 8; guard += 1) {
    if (current instanceof z.ZodOptional) {
      current = current.unwrap();
      continue;
    }
    if (current instanceof z.ZodNullable) {
      current = current.unwrap();
      continue;
    }
    if (current instanceof z.ZodDefault) {
      current = current.removeDefault();
      continue;
    }
    if (current instanceof z.ZodPipe) {
      current = current.in;
      continue;
    }
    break;
  }
  return current;
}

export interface RenderSchemaOptions {
  /** Russian labels keyed by field name (flat across the whole section). */
  labels?: Record<string, string>;
  hints?: Record<string, string>;
  badges?: Record<string, BadgeTone>;
  /** Top-level field names to skip. */
  skip?: readonly string[];
  /** Custom widgets keyed by top-level field name. */
  custom?: Record<string, (ctx: FieldCtx, path: string, parent: HTMLElement) => Sync>;
  /** Group titles for nested objects. */
  groupLabels?: Record<string, string>;
  /** Field names rendered as textareas instead of single-line inputs. */
  multiline?: readonly string[];
}

export interface RenderedFields {
  node: HTMLElement;
  syncs: Sync[];
}

export function renderSchema(
  schema: z.ZodObject,
  basePath: string,
  ctx: FieldCtx,
  options: RenderSchemaOptions = {},
): RenderedFields {
  const node = el('div', 'field-stack');
  const syncs: Sync[] = [];
  const shape: z.ZodRawShape = schema.shape;

  for (const [key, fieldSchema] of Object.entries(shape)) {
    if (options.skip?.includes(key)) continue;
    const path = basePath ? `${basePath}.${key}` : key;
    const custom = options.custom?.[key];
    if (custom) {
      syncs.push(custom(ctx, path, node));
      continue;
    }
    syncs.push(renderField(fieldSchema, path, key, ctx, node, options));
  }

  return { node, syncs };
}

function renderField(
  schema: z.core.$ZodType,
  path: string,
  key: string,
  ctx: FieldCtx,
  parent: HTMLElement,
  options: RenderSchemaOptions,
): Sync {
  const field = unwrapSchema(schema);
  const title = tr(options.labels?.[key] ?? humanizeKey(key));
  const hint = options.hints?.[key] && tr(options.hints[key]);
  const fieldBadge = options.badges?.[key];

  if (field instanceof z.ZodBoolean) {
    return toggleField(ctx, parent, path, title, { hint, badge: fieldBadge });
  }
  if (field instanceof z.ZodNumber) {
    const optional = schema instanceof z.ZodOptional && schema.safeParse(undefined).data === undefined;
    return numberField(ctx, parent, path, title, numberBounds(field), { hint, optional });
  }
  if (field instanceof z.ZodEnum) {
    return selectField(ctx, parent, path, title, field.options.filter((value) => typeof value === 'string'), { hint });
  }
  if (field instanceof z.ZodString) {
    if (options.multiline?.includes(key)) return textareaField(ctx, parent, path, title, { hint });
    const emptyClearsValue = schema instanceof z.ZodOptional && !schema.safeParse('').success;
    return textField(ctx, parent, path, title, {
      hint,
      ...(emptyClearsValue ? { onChange: (value: string) => ctx.set(path, value || undefined) } : {}),
    });
  }
  if (field instanceof z.ZodArray) {
    const element = unwrapSchema(field.element);
    if (element instanceof z.ZodEnum) {
      const choices = element.options.filter((value) => typeof value === 'string');
      return multiSelectField(ctx, parent, path, title, choices, {
        hint,
        badge: fieldBadge,
        labels: options.labels,
        validate: (values) => {
          if (field.safeParse(values).success) return undefined;
          return values.length ? tr('Проверьте выбранные варианты.') : tr('Оставьте хотя бы один вариант.');
        },
      });
    }
    if (element instanceof z.ZodObject) {
      return tableField(ctx, parent, path, element, title, { hint });
    }
    return listField(ctx, parent, path, title, { hint });
  }
  if (field instanceof z.ZodObject) {
    const group = el('div', 'field-group');
    const groupTitle = tr(options.groupLabels?.[key] ?? title);
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', groupTitle);
    group.append(el('div', 'group-title', groupTitle));
    const nested = renderSchema(field, path, ctx, {
      labels: options.labels,
      hints: options.hints,
      badges: options.badges,
      multiline: options.multiline,
      groupLabels: options.groupLabels,
    });
    group.append(nested.node);
    parent.append(group);
    return combineSyncs(nested.syncs);
  }
  return () => undefined;
}
