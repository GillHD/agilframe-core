/** Cards, KPI tiles, bar lists and key/value grids. */
import { h, type Child } from '../dom.js';
import { icon, type IconName } from '../icons.js';
import { emptyState } from './empty-state.js';

export interface CardOptions {
  title?: string;
  subtitle?: string;
  /** Technical name behind the human subtitle, shown as a tooltip. */
  subtitleTitle?: string;
  actions?: Node[];
  body?: Child | Child[];
  className?: string;
  flush?: boolean;
  tight?: boolean;
}

export function card(options: CardOptions = {}): HTMLElement {
  const root = h('section', { class: `card${options.className ? ` ${options.className}` : ''}` });
  if (options.title || options.actions?.length) {
    const head = h('div', { class: 'card-head' });
    const heading = h('div', { class: 'card-heading' });
    if (options.title) heading.appendChild(h('h2', { class: 'card-title', text: options.title }));
    if (options.subtitle) {
      heading.appendChild(
        h('p', {
          class: 'card-subtitle',
          attrs: options.subtitleTitle ? { title: options.subtitleTitle } : undefined,
          text: options.subtitle,
        }),
      );
    }
    head.appendChild(heading);
    if (options.actions && options.actions.length > 0) {
      head.appendChild(h('div', { class: 'card-actions' }, ...options.actions));
    }
    root.appendChild(head);
  }
  if (options.body !== undefined) {
    const body = h('div', {
      class: `card-body${options.flush ? ' is-flush' : options.tight ? ' is-tight' : ''}`,
    });
    const children = Array.isArray(options.body) ? options.body : [options.body];
    for (const child of children) {
      if (child instanceof Node) body.appendChild(child);
      else if (child !== null && child !== undefined && child !== false) {
        body.appendChild(document.createTextNode(String(child)));
      }
    }
    root.appendChild(body);
  }
  return root;
}

export type KpiTone = 'default' | 'success' | 'warning' | 'danger' | 'info';

export interface KpiOptions {
  label: string;
  value: string | number;
  hint?: string;
  iconName?: IconName;
  tone?: KpiTone;
  loading?: boolean;
}

export function kpiCard(options: KpiOptions): HTMLElement {
  const toneClass = options.tone && options.tone !== 'default' ? ` tone-${options.tone}` : '';
  const root = h('div', { class: `kpi${toneClass}` });
  const top = h('div', { class: 'kpi-top' });
  top.appendChild(h('span', { class: 'kpi-label', text: options.label }));
  if (options.iconName) {
    top.appendChild(h('span', { class: 'kpi-icon' }, icon(options.iconName, 17)));
  }
  root.appendChild(top);
  if (options.loading) {
    root.appendChild(h('div', { class: 'skeleton', attrs: { style: 'height:30px;width:90px' } }));
  } else {
    root.appendChild(h('div', { class: 'kpi-value', text: String(options.value) }));
  }
  if (options.hint) root.appendChild(h('div', { class: 'kpi-hint', text: options.hint }));
  return root;
}

export interface BarItem {
  label: string;
  value: number;
  max?: number;
  valueLabel?: string;
}

export function barList(items: readonly BarItem[], emptyMessage = 'Нет данных за период'): HTMLElement {
  if (items.length === 0) {
    return emptyState({ title: emptyMessage, iconName: 'globe', compact: true });
  }
  const max = items.reduce((acc, item) => Math.max(acc, item.max ?? item.value), 0) || 1;
  const root = h('div', { class: 'bar-list' });
  for (const item of items) {
    const percent = Math.round((item.value / max) * 100);
    root.appendChild(
      h(
        'div',
        { class: 'bar-item' },
        h('span', { class: 'bar-label', text: item.label }),
        h(
          'span',
          { class: 'bar-track', attrs: { role: 'progressbar', 'aria-valuenow': item.value, 'aria-valuemin': 0, 'aria-valuemax': max, 'aria-label': item.label } },
          h('span', { class: 'bar-fill', attrs: { style: `width:${percent}%` } }),
        ),
        h('span', { class: 'bar-value', text: item.valueLabel ?? String(item.value) }),
      ),
    );
  }
  return root;
}

export function kv(label: string, value: Child): HTMLElement {
  const root = h('div', { class: 'kv' });
  root.appendChild(h('div', { class: 'kv-label', text: label }));
  const valueNode = h('div', { class: 'kv-value' });
  if (value instanceof Node) valueNode.appendChild(value);
  else valueNode.textContent = value === null || value === undefined || value === false ? '—' : String(value);
  root.appendChild(valueNode);
  return root;
}

export function kvGrid(items: ReadonlyArray<{ label: string; value: Child }>): HTMLElement {
  return h('div', { class: 'kv-grid' }, ...items.map((item) => kv(item.label, item.value)));
}

/** Read-only link row with a copy button (join/embed URLs, endpoints). */
export function linkRow(url: string, copyControl?: Node): HTMLElement {
  const root = h('div', { class: 'link-row' });
  root.appendChild(h('span', { class: 'link-value', text: url, attrs: { title: url } }));
  if (copyControl) root.appendChild(copyControl);
  return root;
}
