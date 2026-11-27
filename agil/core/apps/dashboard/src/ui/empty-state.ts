/** Empty states: the panel never shows a blank region without an explanation. */
import { h } from '../dom.js';
import { icon, type IconName } from '../icons.js';

export interface EmptyStateOptions {
  title: string;
  message?: string;
  iconName?: IconName;
  action?: HTMLElement;
  compact?: boolean;
}

export function emptyState(options: EmptyStateOptions): HTMLElement {
  const root = h('div', { class: `empty${options.compact ? ' is-compact' : ''}` });
  root.append(
    h('span', { class: 'empty-icon', attrs: { 'aria-hidden': 'true' } }, icon(options.iconName ?? 'info', 20)),
    h('div', { class: 'empty-title', text: options.title }),
  );
  if (options.message) root.appendChild(h('p', { class: 'empty-message', text: options.message }));
  if (options.action) root.appendChild(h('div', { class: 'empty-actions' }, options.action));
  return root;
}
