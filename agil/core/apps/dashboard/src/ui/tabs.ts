/** Accessible tabs (roving tabindex, arrow keys) with a single live panel. */
import { h, uid } from '../dom.js';

export interface TabItem {
  id: string;
  label: string;
  count?: number;
}

export interface TabsOptions {
  items: readonly TabItem[];
  active?: string;
  ariaLabel?: string;
  /** Called on every activation (including the initial one). */
  onChange: (id: string, panel: HTMLElement) => void;
}

export interface TabsHandle {
  el: HTMLElement;
  panel: HTMLElement;
  getActive: () => string;
  setActive: (id: string) => void;
}

export function createTabs(options: TabsOptions): TabsHandle {
  const panelId = uid('tabpanel');
  const buttons = new Map<string, HTMLButtonElement>();
  const order: string[] = [];
  let activeId = options.active ?? options.items[0]?.id ?? '';

  const tablist = h('div', {
    class: 'tabs',
    attrs: { role: 'tablist', 'aria-label': options.ariaLabel ?? 'Вкладки' },
  });
  const panel = h('div', {
    class: 'tab-panel',
    attrs: { role: 'tabpanel', id: panelId, tabindex: '0' },
  });

  const select = (id: string, focus = false): void => {
    const target = buttons.get(id);
    if (!target) return;
    activeId = id;
    for (const [itemId, node] of buttons) {
      const isActive = itemId === id;
      node.setAttribute('aria-selected', isActive ? 'true' : 'false');
      node.tabIndex = isActive ? 0 : -1;
    }
    panel.setAttribute('aria-labelledby', target.id);
    panel.replaceChildren();
    options.onChange(id, panel);
    if (focus) target.focus();
  };

  for (const item of options.items) {
    const node = h('button', {
      class: 'tab',
      attrs: {
        type: 'button',
        role: 'tab',
        'data-tab': item.id,
        id: uid('tab'),
        'aria-controls': panelId,
        'aria-selected': 'false',
        tabindex: '-1',
      },
      on: { click: () => select(item.id) },
    });
    node.appendChild(h('span', { text: item.label }));
    if (item.count !== undefined) node.appendChild(h('span', { class: 'tab-count', text: String(item.count) }));
    buttons.set(item.id, node);
    order.push(item.id);
    tablist.appendChild(node);
  }

  tablist.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const currentIndex = order.findIndex((id) => buttons.get(id) === document.activeElement);
    if (currentIndex < 0) return;
    event.preventDefault();
    let next = currentIndex;
    if (event.key === 'ArrowLeft') next = (currentIndex - 1 + order.length) % order.length;
    if (event.key === 'ArrowRight') next = (currentIndex + 1) % order.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = order.length - 1;
    const nextId = order[next];
    if (nextId) select(nextId, true);
  });

  const root = h('div', { class: 'tabs-block' }, tablist, panel);
  if (activeId) select(activeId);

  return {
    el: root,
    panel,
    getActive: () => activeId,
    setActive: (id: string) => select(id),
  };
}
