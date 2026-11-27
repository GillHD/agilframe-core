/** Accessible modal dialog: focus trap, Escape/backdrop close, focus restore. */
import { append, h, uid, type Child } from '../dom.js';
import { t } from '../i18n.js';
import { button } from './controls.js';

export interface ModalOptions {
  title: string;
  body: Child | Child[];
  footer?: Node[];
  size?: 'sm' | 'md' | 'lg';
  onClose?: () => void;
}

export interface ModalHandle {
  root: HTMLElement;
  close: () => void;
}

let openCount = 0;

function trapFocus(event: KeyboardEvent, container: HTMLElement): void {
  const focusable = Array.from(
    container.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => element.offsetParent !== null || element === document.activeElement);
  if (focusable.length === 0) {
    event.preventDefault();
    container.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!first || !last) return;
  const active = document.activeElement;
  if (event.shiftKey) {
    if (active === first || !container.contains(active)) {
      event.preventDefault();
      last.focus();
    }
  } else if (active === last || !container.contains(active)) {
    event.preventDefault();
    first.focus();
  }
}

export function openModal(options: ModalOptions): ModalHandle {
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const titleId = uid('modal-title');
  const bodyId = uid('modal-body');
  let closed = false;

  const dialog = h('div', {
    class: `modal modal-${options.size ?? 'md'}`,
    attrs: {
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': titleId,
      'aria-describedby': bodyId,
      tabindex: '-1',
    },
  });

  const overlay = h('div', { class: 'modal-backdrop' }, dialog);

  const close = (): void => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKeyDown, true);
    overlay.remove();
    openCount = Math.max(0, openCount - 1);
    if (openCount === 0) document.body.classList.remove('modal-open');
    options.onClose?.();
    if (previousFocus && previousFocus.isConnected) previousFocus.focus();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === 'Tab') trapFocus(event, dialog);
  };

  dialog.append(
    h(
      'div',
      { class: 'modal-head' },
      h('h2', { class: 'modal-title', text: options.title, attrs: { id: titleId } }),
      button(undefined, { variant: 'subtle', size: 'sm', icon: 'x', title: t('common.closeDialog'), onClick: close }),
    ),
  );

  const body = h('div', { class: 'modal-body', attrs: { id: bodyId } });
  append(body, ...(Array.isArray(options.body) ? options.body : [options.body]));
  dialog.appendChild(body);

  if (options.footer && options.footer.length > 0) {
    dialog.appendChild(h('div', { class: 'modal-footer' }, ...options.footer));
  }

  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close();
  });
  document.addEventListener('keydown', onKeyDown, true);
  document.body.appendChild(overlay);
  openCount += 1;
  document.body.classList.add('modal-open');

  window.setTimeout(() => {
    const preferred = dialog.querySelector<HTMLElement>('[data-autofocus]');
    if (preferred) {
      preferred.focus();
      return;
    }
    const first = dialog.querySelector<HTMLElement>(
      'input, select, textarea, button.btn-primary, button.btn-danger, button.btn-ghost',
    );
    (first ?? dialog).focus();
  }, 0);

  return { root: overlay, close };
}
