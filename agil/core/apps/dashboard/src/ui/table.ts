/** Typed data table with an empty state, optional row activation and horizontal scroll. */
import { h, type Child } from '../dom.js';
import { emptyState } from './empty-state.js';

export interface Column<T> {
  key: string;
  header: string;
  className?: string;
  align?: 'left' | 'right' | 'center';
  render: (row: T, index: number) => Child;
}

/**
 * Accessible action of a clickable row (WCAG 4.1.2, 2.4.4).
 *
 * `href` renders a real link inside the first cell — the preferred pattern:
 * native link semantics, context menu, middle click and a meaningful Tab stop.
 * Without `href` the row itself becomes a `button`/`link` with Enter/Space
 * activation, which is only appropriate when the row has no nested controls.
 */
export interface RowAction {
  /** Accessible name with the row identity, e.g. «Открыть комнату «Демо», ID abc». */
  label: string;
  /** Hash or absolute URL for the real-link variant. */
  href?: string;
  /** Row role for the non-link variant (default `button`). */
  role?: 'button' | 'link';
}

export interface DataTableOptions<T> {
  columns: readonly Column<T>[];
  rows: readonly T[];
  caption?: string;
  empty?: Child;
  onRowClick?: (row: T, event: MouseEvent) => void;
  /** Action semantics for a clickable row; keeps mouse row clicks working. */
  rowAction?: (row: T, index: number) => RowAction | null;
  minWidth?: number;
  className?: string;
  rowKey?: (row: T, index: number) => string;
}

const INTERACTIVE = 'button, a, input, select, textarea, label';

/** Fallback only — every caller should pass `rowAction` with a real identity. */
function derivedLabel(cell: HTMLElement): string {
  const text = (cell.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return text ? `Открыть: ${text}` : 'Открыть строку';
}

export function dataTable<T>(options: DataTableOptions<T>): HTMLElement {
  const wrapper = h('div', { class: 'table-wrap' });
  const table = h('table', {
    class: `data${options.className ? ` ${options.className}` : ''}`,
    attrs: options.minWidth ? { style: `min-width:${options.minWidth}px` } : undefined,
  });
  if (options.caption) table.appendChild(h('caption', { text: options.caption }));

  const thead = h('thead');
  const headRow = h('tr');
  for (const column of options.columns) {
    const th = h('th', {
      class: column.align ? `align-${column.align}` : undefined,
      attrs: { scope: 'col' },
      text: column.header,
    });
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = h('tbody');
  if (options.rows.length === 0) {
    const row = h('tr');
    const cell = h('td', { attrs: { colspan: String(options.columns.length) } });
    const emptyContent =
      options.empty ??
      emptyState({
        title: 'Данных пока нет',
        message: 'Здесь появятся данные, когда сервер их вернёт.',
        compact: true,
      });
    if (emptyContent instanceof Node) cell.appendChild(emptyContent);
    else if (emptyContent !== null && emptyContent !== undefined && emptyContent !== false) {
      cell.appendChild(document.createTextNode(String(emptyContent)));
    }
    row.appendChild(cell);
    tbody.appendChild(row);
  } else {
    options.rows.forEach((row, index) => {
      const tr = h('tr');
      if (options.rowKey) tr.dataset.key = options.rowKey(row, index);
      const cells: HTMLTableCellElement[] = [];
      for (const column of options.columns) {
        const td = h('td', { class: column.align ? `align-${column.align}` : undefined });
        td.dataset.label = column.header;
        const content = column.render(row, index);
        if (content instanceof Node) td.appendChild(content);
        else if (content !== null && content !== undefined && content !== false) {
          td.appendChild(document.createTextNode(String(content)));
        }
        cells.push(td);
        tr.appendChild(td);
      }

      const clickable = Boolean(options.onRowClick || options.rowAction);
      if (clickable) {
        tr.classList.add('row-clickable');
        const action = options.rowAction?.(row, index) ?? null;
        const firstCell = cells[0];
        if (action?.href && firstCell) {
          // Preferred: a real link in the first cell. The row stays clickable for
          // the mouse, but keyboard/screen-reader users get native link semantics.
          const anchor = h('a', {
            class: 'row-action-link',
            attrs: { href: action.href, 'aria-label': action.label },
          });
          const nested = firstCell.querySelector(INTERACTIVE);
          if (nested) {
            // Never nest interactive elements inside a link; keep the link as a
            // screen-reader-only action next to the existing control instead.
            anchor.className = 'row-action-link sr-only';
            anchor.textContent = action.label;
            firstCell.appendChild(anchor);
          } else {
            while (firstCell.firstChild) anchor.appendChild(firstCell.firstChild);
            firstCell.appendChild(anchor);
          }
          anchor.addEventListener('click', (event) => {
            if (!options.onRowClick) return;
            // Keep native behaviour for modified clicks (new tab/window); a plain
            // click/Enter runs the caller's action exactly once.
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            options.onRowClick(row, event);
          });
        } else {
          const label = action?.label ?? (firstCell ? derivedLabel(firstCell) : 'Открыть строку');
          tr.tabIndex = 0;
          tr.setAttribute('role', action?.role ?? 'button');
          tr.setAttribute('aria-label', label);
          tr.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            const target = event.target;
            if (target instanceof Element && target.closest(INTERACTIVE)) return;
            event.preventDefault();
            options.onRowClick?.(row, event as unknown as MouseEvent);
          });
        }
        tr.addEventListener('click', (event) => {
          const target = event.target;
          if (target instanceof Element && target.closest(INTERACTIVE)) return;
          options.onRowClick?.(row, event);
        });
      }
      tbody.appendChild(tr);
    });
  }
  table.appendChild(tbody);
  wrapper.appendChild(table);
  return wrapper;
}
