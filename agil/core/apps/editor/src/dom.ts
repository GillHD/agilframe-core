/**
 * Small DOM / browser helpers shared by every editor module.
 *
 * No dependencies beyond the DOM: the editor must work fully offline.
 */

import { tr } from './i18n';

export type IconName =
  | 'sun'
  | 'moon'
  | 'refresh'
  | 'external'
  | 'copy'
  | 'download'
  | 'save'
  | 'upload'
  | 'reset'
  | 'plus'
  | 'trash'
  | 'edit'
  | 'check'
  | 'alert'
  | 'code'
  | 'palette'
  | 'sliders'
  | 'layers'
  | 'shield'
  | 'video'
  | 'sparkles'
  | 'door'
  | 'grid'
  | 'info'
  | 'file'
  | 'key'
  | 'book'
  | 'plug';

export type BadgeTone = 'roadmap' | 'beta' | 'ok' | 'warn' | 'fail' | 'muted' | 'info';

export type ToastTone = 'info' | 'success' | 'error';

const SVG_NS = 'http://www.w3.org/2000/svg';

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Creates an SVG icon that references a symbol from the inline sprite in index.html. */
export function icon(name: IconName, className = 'icon'): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

export function button(label: string, className = 'btn', iconName?: IconName): HTMLButtonElement {
  const node = el('button', className);
  node.type = 'button';
  if (iconName) node.append(icon(iconName));
  if (label) node.append(el('span', 'btn-label', label));
  return node;
}

export function iconButton(name: IconName, label: string, className = 'icon-button'): HTMLButtonElement {
  const node = el('button', className);
  node.type = 'button';
  node.title = label;
  node.setAttribute('aria-label', label);
  node.append(icon(name));
  return node;
}

let confirmDialogId = 0;

export interface ConfirmDialogOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

/**
 * Styled in-app confirmation (native `window.confirm` cannot be themed,
 * screenshotted or translated consistently with the rest of the editor).
 * Resolves `true` only when the user presses the confirm button.
 */
export function confirmAction(options: ConfirmDialogOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    confirmDialogId += 1;
    const titleId = `confirm-dialog-title-${confirmDialogId}`;
    const messageId = `confirm-dialog-message-${confirmDialogId}`;

    const dialog = el('dialog', 'confirm-dialog');
    dialog.setAttribute('aria-labelledby', titleId);
    dialog.setAttribute('aria-describedby', messageId);

    const body = el('div', 'confirm-dialog-body');
    const title = el('h2', 'confirm-dialog-title', options.title);
    title.id = titleId;
    const message = el('p', 'confirm-dialog-message', options.message);
    message.id = messageId;
    body.append(title, message);

    const actions = el('div', 'confirm-dialog-actions');
    const cancel = button(options.cancelLabel ?? tr('Отмена'), 'btn');
    cancel.dataset.testid = 'confirm-cancel';
    const confirm = button(options.confirmLabel ?? tr('Подтвердить'), options.danger ? 'btn btn-danger' : 'btn btn-primary');
    confirm.dataset.testid = 'confirm-accept';
    actions.append(cancel, confirm);
    dialog.append(body, actions);

    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      if (dialog.open) dialog.close();
      dialog.remove();
      resolve(value);
    };

    cancel.addEventListener('click', () => finish(false));
    confirm.addEventListener('click', () => finish(true));
    // Native <dialog> does not close on a backdrop click; treat it as cancel.
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) finish(false);
    });
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      finish(false);
    });
    dialog.addEventListener('close', () => finish(false));

    document.body.append(dialog);
    dialog.showModal();
    confirm.focus({ preventScroll: true });
  });
}

export function badge(text: string, tone: BadgeTone = 'muted'): HTMLSpanElement {
  const node = el('span', `badge badge-${tone}`, text);
  return node;
}

export function setBadge(node: HTMLElement, text: string, tone: BadgeTone, title = ''): void {
  node.className = `badge badge-${tone}`;
  node.textContent = text;
  if (title) node.title = title;
  else node.removeAttribute('title');
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function humanizeKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
    .trim();
  return words.length > 0 ? words.charAt(0).toUpperCase() + words.slice(1) : key;
}

export function formatClock(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '';
  return new Date(timestamp).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

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
    // Private mode / quota exceeded: the editor keeps working without a draft.
  }
}

export interface Debounced<A extends unknown[]> {
  (...args: A): void;
  flush(): void;
  cancel(): void;
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, waitMs: number): Debounced<A> {
  let timer: number | undefined;
  let pending: A | undefined;

  const flush = (): void => {
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timer = undefined;
    }
    const args = pending;
    pending = undefined;
    if (args) fn(...args);
  };

  const cancel = (): void => {
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timer = undefined;
    }
    pending = undefined;
  };

  const wrapped = (...args: A): void => {
    pending = args;
    if (timer !== undefined) window.clearTimeout(timer);
    timer = window.setTimeout(flush, waitMs);
  };

  return Object.assign(wrapped, { flush, cancel });
}

export function toast(message: string, tone: ToastTone = 'info'): void {
  const stack = document.getElementById('toasts');
  if (!stack) return;
  const node = el('div', `toast toast-${tone}`);
  if (tone === 'success') node.append(icon('check'));
  if (tone === 'error') node.append(icon('alert'));
  node.append(el('span', undefined, message));
  stack.append(node);
  window.setTimeout(() => {
    node.classList.add('is-leaving');
    window.setTimeout(() => node.remove(), 220);
  }, 3400);
}

/** Clipboard with a `document.execCommand` fallback for non-secure contexts. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy path.
  }
  try {
    const area = el('textarea', 'clipboard-proxy');
    area.value = text;
    area.setAttribute('readonly', 'readonly');
    document.body.append(area);
    area.select();
    const copied = document.execCommand('copy');
    area.remove();
    return copied;
  } catch {
    return false;
  }
}

export function downloadText(filename: string, text: string, mime = 'application/json'): void {
  try {
    const blob = new Blob([text], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const link = el('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch {
    toast(tr('Не удалось скачать файл: браузер заблокировал сохранение. Разрешите скачивание и повторите.'), 'error');
  }
}
