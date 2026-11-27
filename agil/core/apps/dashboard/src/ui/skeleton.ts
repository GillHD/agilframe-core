/** Loading skeletons shown while an API request is in flight. */
import { h } from '../dom.js';

export interface SkeletonOptions {
  lines?: number;
  height?: number;
  className?: string;
}

export function skeletonBlock(options: SkeletonOptions = {}): HTMLElement {
  const root = h('div', { class: options.className ?? '', attrs: { 'aria-hidden': 'true' } });
  const height = options.height ?? 12;
  const lines = options.lines ?? 3;
  for (let index = 0; index < lines; index += 1) {
    const width = index === lines - 1 ? 62 : 100 - index * 6;
    root.appendChild(
      h('div', {
        class: 'skeleton skeleton-line',
        attrs: { style: `height:${height}px;width:${width}%` },
      }),
    );
  }
  return root;
}

export function skeletonTable(rows = 5, cols = 4): HTMLElement {
  const root = h('div', { class: 'skeleton-table', attrs: { 'aria-hidden': 'true' } });
  for (let row = 0; row < rows; row += 1) {
    const rowNode = h('div', { class: 'skeleton-row' });
    for (let col = 0; col < cols; col += 1) {
      const width = col === 0 ? 120 : 60 + ((row + col) % 3) * 20;
      rowNode.appendChild(
        h('div', {
          class: 'skeleton',
          attrs: { style: `height:12px;width:${width}px;flex:0 1 ${width}px` },
        }),
      );
    }
    root.appendChild(rowNode);
  }
  return root;
}

export function loadingPanel(label = 'Загрузка…'): HTMLElement {
  return h(
    'div',
    { class: 'loading-panel', attrs: { role: 'status', 'aria-live': 'polite' } },
    h('span', { class: 'spinner', attrs: { 'aria-hidden': 'true' } }),
    h('span', { text: label }),
  );
}
