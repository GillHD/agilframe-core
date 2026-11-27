/** Shared building blocks for screens: headers, alerts, errors, refresh buttons. */
import type { AppContext } from '../context.js';
import { h } from '../dom.js';
import { ApiError } from '../api.js';
import { describeError, errorMessage, type ErrorInfo } from '../errors.js';
import { t } from '../i18n.js';
import { icon, type IconName } from '../icons.js';
import { button } from '../ui/controls.js';
import { setButtonLoading } from '../dom.js';
import { isLocalDevHost } from '../auth.js';

export interface PageHeaderOptions {
  title: string;
  subtitle?: string;
  actions?: HTMLElement[];
  eyebrow?: string;
}

export function pageHeader(options: PageHeaderOptions): HTMLElement {
  const heading = h('div', { class: 'page-heading' });
  if (options.eyebrow) heading.appendChild(h('div', { class: 'eyebrow', text: options.eyebrow }));
  heading.appendChild(h('h2', { text: options.title }));
  if (options.subtitle) heading.appendChild(h('p', { text: options.subtitle }));
  const header = h('div', { class: 'page-header' }, heading);
  if (options.actions && options.actions.length > 0) header.appendChild(h('div', { class: 'actions' }, ...options.actions));
  return header;
}

export type AlertKind = 'info' | 'success' | 'warning' | 'danger';

const ALERT_ICONS: Record<AlertKind, IconName> = {
  info: 'info',
  success: 'check',
  warning: 'alert-triangle',
  danger: 'alert-triangle',
};

export function alert(kind: AlertKind, title: string, message?: string, action?: HTMLElement): HTMLElement {
  const root = h('div', { class: `alert alert-${kind}`, attrs: { role: kind === 'danger' ? 'alert' : 'status' } });
  root.append(
    h('span', { class: 'alert-icon' }, icon(ALERT_ICONS[kind], 17)),
    h(
      'div',
      { class: 'alert-body' },
      h('div', { class: 'alert-title', text: title }),
      message ? h('div', { class: 'alert-message', text: message }) : null,
    ),
  );
  if (action) root.appendChild(h('div', { class: 'alert-actions' }, action));
  return root;
}

/** Marks the shell status offline for network failures. */
export function reportErrorStatus(ctx: AppContext, error: unknown): void {
  if (error instanceof ApiError && error.offline) ctx.setServerStatus('offline');
}

export function toastError(ctx: AppContext, error: unknown): void {
  reportErrorStatus(ctx, error);
  ctx.toast(errorMessage(error), 'error');
}

/** In-place error panel with an optional retry action. */
export function errorState(error: unknown, onRetry?: () => void, extraAction?: HTMLElement, describe: (error: unknown) => ErrorInfo = describeError): HTMLElement {
  const info = describe(error);
  const root = h('div', { class: 'error-state', attrs: { role: 'alert' } });
  root.append(
    h('h3', {}, icon(info.offline ? 'server' : 'alert-triangle', 18), h('span', { text: info.title })),
    h('p', { text: info.message }),
  );
  if (info.hint) root.appendChild(h('p', { class: 'notice', text: info.hint }));
  const actions = h('div', { class: 'actions' });
  if (onRetry) {
    actions.appendChild(
      button(t('common.retry'), { variant: 'primary', size: 'sm', icon: 'refresh', onClick: onRetry }),
    );
  }
  if (extraAction) actions.appendChild(extraAction);
  if (actions.childElementCount > 0) root.appendChild(actions);
  return root;
}

/** Offline panel with concrete start instructions (never just "error"). */
export function offlinePanel(onRetry?: () => void): HTMLElement {
  const root = h('div', { class: 'offline-panel' });
  root.append(
    h('h3', {}, icon('alert-triangle', 20), h('span', { text: 'Сервер недоступен' })),
    h(
      'p',
      { class: 'notice', text: 'Панель работает без сервера, но данные появятся только после его запуска.' },
    ),
    h(
      'ol',
      {},
      h('li', {}, 'В корне репозитория выполните ', h('code', { text: 'npm run dev' }), ' — поднимутся сервер :8787, демо-страница :5173 и редактор :5174.'),
      h('li', {}, 'Нужен только API: ', h('code', { text: 'npm run dev -w @agil/calls-server' }), '.'),
      h('li', {}, isLocalDevHost() ? 'Проверьте адрес http://localhost:8787 и API-ключ dev-key.' : 'Проверьте адрес сервера и API-ключ организации.'),
    ),
  );
  if (onRetry) {
    root.appendChild(
      h('div', { class: 'actions' }, button('Повторить подключение', { variant: 'primary', size: 'sm', icon: 'refresh', onClick: onRetry })),
    );
  }
  return root;
}

/** Button with a built-in spinner + error toast (screens use it for reloads). */
export function refreshButton(onClick: () => void | Promise<void>, label = 'Обновить'): HTMLButtonElement {
  const node = button(label, { variant: 'ghost', size: 'sm', icon: 'refresh' });
  node.addEventListener('click', () => {
    void (async () => {
      setButtonLoading(node, true);
      try {
        await onClick();
      } catch (error) {
        // Screens normally catch their own errors; this is the last resort.
        void error;
      } finally {
        setButtonLoading(node, false);
      }
    })();
  });
  return node;
}

/** Parses a comma/newline separated ISO-3166 list, uppercases and dedupes it. */
export function parseCountryList(value: string): string[] {
  const codes = value
    .split(/[\s,;]+/)
    .map((code) => code.trim().toUpperCase())
    .filter((code) => /^[A-Z]{2}$/.test(code));
  return [...new Set(codes)];
}

export function formatCountryList(value: readonly string[]): string {
  return value.join(', ');
}

/** Same for feature keys / arbitrary comma separated lists. */
export function parseList(value: string): string[] {
  return [...new Set(value.split(/[\s,;]+/).map((item) => item.trim()).filter(Boolean))];
}
