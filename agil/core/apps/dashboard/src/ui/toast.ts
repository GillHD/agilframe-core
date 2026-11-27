/** Toast notifications with an aria-live region. */
import { h } from '../dom.js';
import { t } from '../i18n.js';
import { icon, type IconName } from '../icons.js';

export type ToastKind = 'success' | 'error' | 'warning' | 'info';

const ICON_BY_KIND: Record<ToastKind, IconName> = {
  success: 'check',
  error: 'alert-triangle',
  warning: 'alert-triangle',
  info: 'info',
};

const MAX_TOASTS = 2;
let region: HTMLElement | null = null;

/** The shell mounts the live region outside its scrolling content. */
export function createToastRegion(): HTMLElement {
  const element = h('div', {
    class: 'toast-region',
    attrs: { 'aria-live': 'polite', 'aria-atomic': 'false' },
  });
  region = element;
  return element;
}

/** Shows a toast; returns a dismiss function. */
export function toast(
  message: string,
  kind: ToastKind = 'info',
  options: { timeoutMs?: number } = {},
): () => void {
  const container = region;
  if (!container?.isConnected) return () => {};
  while (container.children.length >= MAX_TOASTS) container.firstElementChild?.remove();

  let dismissed = false;
  const dismiss = (): void => {
    if (dismissed) return;
    dismissed = true;
    node.classList.add('is-leaving');
    if (node.contains(document.activeElement)) {
      const next = container.querySelector<HTMLButtonElement>('.toast:not(.is-leaving) .toast-close');
      if (next) next.focus();
      else document.getElementById('dashboard-view')?.focus({ preventScroll: true });
    }
    window.setTimeout(() => node.remove(), 220);
  };

  const node = h('div', {
    class: `toast toast-${kind}`,
    attrs: { role: kind === 'error' ? 'alert' : 'status' },
  });
  node.append(
    h('span', { class: 'toast-icon' }, icon(ICON_BY_KIND[kind], 16)),
    h('span', { class: 'toast-message', text: message }),
    h(
      'button',
      {
        class: 'toast-close',
        attrs: { type: 'button', 'aria-label': t('common.dismissNotification') },
        on: { click: dismiss },
      },
      icon('x', 16),
    ),
  );
  container.appendChild(node);
  if (!container.contains(document.activeElement)) container.scrollTop = container.scrollHeight;
  window.setTimeout(dismiss, options.timeoutMs ?? (kind === 'error' ? 7000 : 4200));
  return dismiss;
}
